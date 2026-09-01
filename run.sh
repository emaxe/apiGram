#!/usr/bin/env sh
#
# apiGram — интерактивный помощник сборки и запуска.
#
#   ./run.sh              меню
#   ./run.sh <команда>    прямой вызов, напр. ./run.sh dev
#
# Команды: install | start | start:proxy | dev | dev:proxy | test | smoke | proxy | env | health | doctor | clean

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT" || exit 1

# ---------------------------------------------------------------- оформление

if [ -t 1 ]; then
    C_RESET=$(printf '\033[0m')
    C_BOLD=$(printf '\033[1m')
    C_DIM=$(printf '\033[90m')
    C_OK=$(printf '\033[32m')
    C_WARN=$(printf '\033[33m')
    C_ERR=$(printf '\033[31m')
    C_ACC=$(printf '\033[36m')
else
    C_RESET='' C_BOLD='' C_DIM='' C_OK='' C_WARN='' C_ERR='' C_ACC=''
fi

head()  { printf '\n%s== %s ==%s\n\n' "$C_BOLD" "$1" "$C_RESET"; }
info()  { printf '%s\n' "$1"; }
dim()   { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
ok()    { printf '%s  ok  %s %s\n' "$C_OK" "$C_RESET" "$1"; }
warn()  { printf '%s warn %s %s\n' "$C_WARN" "$C_RESET" "$1"; }
fail()  { printf '%s fail %s %s\n' "$C_ERR" "$C_RESET" "$1"; }
die()   { fail "$1"; exit 1; }

confirm() {
    printf '%s [y/N]: ' "$1"
    read -r _answer || return 1
    case "$_answer" in
        y|Y|yes|YES|д|да) return 0 ;;
        *) return 1 ;;
    esac
}

# ------------------------------------------------------------------- утилиты

# env_get КЛЮЧ [ЗНАЧЕНИЕ_ПО_УМОЛЧАНИЮ] — читает значение из .env
env_get() {
    _key=$1
    _default=${2-}
    _val=''
    if [ -f "$ROOT/.env" ]; then
        _val=$(sed -n "s/^[[:space:]]*$_key[[:space:]]*=[[:space:]]*//p" "$ROOT/.env" | tail -n 1)
        _val=${_val%\"}; _val=${_val#\"}
        _val=${_val%\'}; _val=${_val#\'}
    fi
    [ -n "$_val" ] || _val=$_default
    printf '%s' "$_val"
}

mask() {
    _v=$1
    if [ -z "$_v" ]; then
        printf '%s(пусто)%s' "$C_DIM" "$C_RESET"
    elif [ ${#_v} -le 4 ]; then
        printf '****'
    else
        printf '%s…%s' "$(printf '%s' "$_v" | cut -c1-2)" "$(printf '%s' "$_v" | rev | cut -c1-2 | rev)"
    fi
}

mask_proxy_url() {
    _u=$1
    if [ -z "$_u" ]; then
        printf '%s(пусто)%s' "$C_DIM" "$C_RESET"
    else
        printf '%s' "$_u" | sed -e 's|://.*@|://***@|' -e 's|secret=[^&]*|secret=***|'
    fi
}

proxy_cache_file() {
    _data=$(env_get DATA_DIR ./data)
    _dir="$ROOT/${_data#./}"
    printf '%s/.proxy' "$_dir"
}

cached_proxy_get() {
    _file=$(proxy_cache_file)
    if [ -f "$_file" ]; then
        _val=''
        read -r _val < "$_file" 2>/dev/null || true
        printf '%s' "$_val"
    fi
}

cached_proxy_set() {
    _val=$1
    _file=$(proxy_cache_file)
    _dir=$(dirname "$_file")
    [ -d "$_dir" ] || { mkdir -p "$_dir" && chmod 700 "$_dir" 2>/dev/null || true; }
    printf '%s\n' "$_val" > "$_file"
    chmod 600 "$_file" 2>/dev/null || true
}

cached_proxy_clear() {
    _file=$(proxy_cache_file)
    if [ -f "$_file" ]; then
        rm -f "$_file"
    fi
}

suggest_proxy() {
    _env_proxy=$(env_get PROXY_URL)
    if [ -n "$_env_proxy" ]; then
        printf '%s' "$_env_proxy"
        return 0
    fi
    for _name in https_proxy HTTPS_PROXY all_proxy ALL_PROXY http_proxy HTTP_PROXY; do
        eval "_val=\${$_name-}"
        if [ -n "$_val" ]; then
            printf '%s' "$_val"
            return 0
        fi
    done
}

ensure_proxy() {
    if [ -n "${PROXY_URL-}" ]; then
        cached_proxy_set "$PROXY_URL"
        ok "прокси из окружения: $(mask_proxy_url "$PROXY_URL") (сохранён в кэш)" >&2
        printf '%s' "$PROXY_URL"
        return 0
    fi

    _cached=$(cached_proxy_get)
    if [ -n "$_cached" ]; then
        ok "прокси из кэша: $(mask_proxy_url "$_cached")" >&2
        dim "  (для изменения: ./run.sh proxy или запуск с флагом --reset)" >&2
        printf '%s' "$_cached"
        return 0
    fi

    warn "прокси не настроен в кэше." >&2
    dim "  Формат: socks5://[user:pass@]host:port, http://host:port, mtproxy://secret@host:443" >&2

    _suggest=$(suggest_proxy)
    if [ -n "$_suggest" ]; then
        dim "  Найдено значение по умолчанию: $(mask_proxy_url "$_suggest")" >&2
        printf 'Введите URL прокси [%s]: ' "$_suggest" >&2
        read -r _ans || { fail "ввод отменён." >&2; return 1; }
        _ans=$(printf '%s' "$_ans" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        if [ -z "$_ans" ]; then
            _ans="$_suggest"
        fi
    else
        printf 'Введите URL прокси: ' >&2
        read -r _ans || { fail "ввод отменён." >&2; return 1; }
        _ans=$(printf '%s' "$_ans" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    fi

    if [ -z "$_ans" ]; then
        fail "прокси не указан, запуск отменён." >&2
        return 1
    fi

    if ! printf '%s' "$_ans" | grep -q '://'; then
        warn "в адресе нет схемы, предполагаю socks5://$_ans" >&2
        _ans="socks5://$_ans"
    fi

    cached_proxy_set "$_ans"
    ok "прокси сохранён в кэш: $(mask_proxy_url "$_ans")" >&2
    printf '%s' "$_ans"
    return 0
}

base_url() {
    _host=$(env_get HOST 127.0.0.1)
    _port=$(env_get PORT 3111)
    printf 'http://%s:%s' "$_host" "$_port"
}

port_busy() {
    _port=$(env_get PORT 3111)
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$_port" -sTCP:LISTEN >/dev/null 2>&1
    else
        return 1
    fi
}

# Идентификаторы процессов, слушающих порт.
port_pids() {
    _port=$(env_get PORT 3111)
    command -v lsof >/dev/null 2>&1 || return 0
    lsof -nP -iTCP:"$_port" -sTCP:LISTEN -t 2>/dev/null
}

# curl до собственного сервера.
#
# `--noproxy` обязателен. Системный прокси (`http_proxy`/`https_proxy`) ловит и
# обращения к 127.0.0.1: запрос уходит наружу и возвращается ошибкой прокси —
# чаще всего 500. Выглядит это как мёртвый сервер, хотя он жив и отвечает.
curl_local() {
    curl -fsS --max-time 5 --noproxy '*' "$@"
}

# Рассказывает, кто держит порт, и предлагает освободить его.
#
# Без этого «порт занят» — тупик: чаще всего его держит собственный забытый
# процесс, оставшийся от прошлого запуска или от фоновой проверки, и узнать об
# этом можно только руками через lsof.
port_report() {
    _port=$(env_get PORT 3111)
    _pids=$(port_pids)

    if [ -z "$_pids" ]; then
        # lsof отсутствует — сказать про порт нечего, но и мешать не будем.
        return 1
    fi

    for _pid in $_pids; do
        _cmd=$(ps -o command= -p "$_pid" 2>/dev/null | cut -c1-90)
        info "  PID $_pid: ${_cmd:-неизвестный процесс}"
        _cwd=$(lsof -a -p "$_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
        if [ -n "$_cwd" ]; then
            if [ "$_cwd" = "$ROOT" ]; then
                dim "           каталог: $_cwd  — это apiGram: другое окно или забытый запуск"
            else
                dim "           каталог: $_cwd"
            fi
        fi
    done

    if command -v curl >/dev/null 2>&1 && curl_local "$(base_url)/v1/health" >/dev/null 2>&1; then
        dim "  на $(base_url)/v1/health он отвечает — то есть health скажет, что всё хорошо"
    fi
    return 0
}

# Завершает процессы на порту. Сначала вежливо, потом жёстко.
free_port() {
    _port=$(env_get PORT 3111)
    _pids=$(port_pids)
    [ -n "$_pids" ] || return 0

    for _pid in $_pids; do kill "$_pid" 2>/dev/null; done
    _n=0
    while [ $_n -lt 10 ]; do
        port_busy || { ok "порт $_port освобождён."; return 0; }
        sleep 1
        _n=$((_n + 1))
    done

    warn "процесс не завершился за 10 с, отправляю KILL."
    for _pid in $(port_pids); do kill -9 "$_pid" 2>/dev/null; done
    sleep 1
    if port_busy; then
        fail "порт $_port всё ещё занят."
        return 1
    fi
    ok "порт $_port освобождён."
}

# Общая ветка для start и dev: порт занят — объясниться и предложить выход.
handle_busy_port() {
    fail "порт $(env_get PORT 3111) уже занят."
    port_report || {
        dim "  кто именно — сказать нечем: lsof не найден в PATH"
        return 1
    }
    printf '\n'
    confirm "Завершить эти процессы и продолжить?" || return 1
    free_port
}

require_node() {
    command -v node >/dev/null 2>&1 || die "node не найден в PATH."
    _major=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$_major" -lt 18 ]; then
        die "нужен Node.js >= 18, установлен $(node -v)."
    fi
}

require_deps() {
    if [ ! -d "$ROOT/node_modules" ]; then
        warn "node_modules отсутствует."
        if confirm "Выполнить npm install сейчас?"; then
            cmd_install || return 1
        else
            return 1
        fi
    fi
    return 0
}

require_env() {
    if [ ! -f "$ROOT/.env" ]; then
        warn ".env отсутствует."
        if confirm "Создать .env из .env.example?"; then
            cp "$ROOT/.env.example" "$ROOT/.env" && chmod 600 "$ROOT/.env"
            ok ".env создан — заполните TELEGRAM_API_ID / TELEGRAM_API_HASH."
        fi
        return 1
    fi
    _id=$(env_get TELEGRAM_API_ID)
    _hash=$(env_get TELEGRAM_API_HASH)
    if [ -z "$_id" ] || [ -z "$_hash" ]; then
        warn "TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы в .env."
        dim "  Ключи: https://my.telegram.org -> API development tools"
        return 1
    fi
    return 0
}

# ------------------------------------------------------------------ команды

cmd_install() {
    head "Установка зависимостей"
    require_node
    if [ -f "$ROOT/package-lock.json" ] && confirm "Использовать npm ci (чистая установка по lock-файлу)?"; then
        npm ci
    else
        npm install
    fi
    _rc=$?
    [ $_rc -eq 0 ] && ok "зависимости установлены." || fail "установка завершилась с кодом $_rc."
    return $_rc
}

cmd_start() {
    head "Запуск сервера (production)"
    require_node
    require_deps || return 1
    require_env || warn "сервер стартует, но авторизация аккаунтов работать не будет."
    if port_busy; then
        handle_busy_port || return 1
    fi
    dim "  $(base_url)/v1    Ctrl+C — остановить"
    printf '\n'
    npm start
}

cmd_start_proxy() {
    _arg=${1-}
    if [ "$_arg" = "--reset" ] || [ "$_arg" = "-r" ] || [ "$_arg" = "--change" ] || [ "$_arg" = "--new" ]; then
        cached_proxy_clear
    elif [ -n "$_arg" ] && [ "$_arg" != "--proxy" ] && [ "$_arg" != "-p" ] && [ "$_arg" != "--with-proxy" ]; then
        cached_proxy_set "$_arg"
    fi
    head "Запуск сервера с прокси (production)"
    require_node
    require_deps || return 1
    require_env || warn "сервер стартует, но авторизация аккаунтов работать не будет."
    if port_busy; then
        handle_busy_port || return 1
    fi
    _proxy=$(ensure_proxy) || return 1
    dim "  $(base_url)/v1    Ctrl+C — остановить"
    dim "  прокси: $(mask_proxy_url "$_proxy")"
    printf '\n'
    PROXY_URL="$_proxy" npm start
}

cmd_dev() {
    head "Запуск сервера (watch)"
    require_node
    require_deps || return 1
    require_env || warn "сервер стартует, но авторизация аккаунтов работать не будет."
    if port_busy; then
        handle_busy_port || return 1
    fi
    dim "  $(base_url)/v1    перезапуск при изменении src/    Ctrl+C — остановить"
    printf '\n'
    node --watch src/index.js
}

cmd_dev_proxy() {
    _arg=${1-}
    if [ "$_arg" = "--reset" ] || [ "$_arg" = "-r" ] || [ "$_arg" = "--change" ] || [ "$_arg" = "--new" ]; then
        cached_proxy_clear
    elif [ -n "$_arg" ] && [ "$_arg" != "--proxy" ] && [ "$_arg" != "-p" ] && [ "$_arg" != "--with-proxy" ]; then
        cached_proxy_set "$_arg"
    fi
    head "Запуск сервера с автоперезапуском (прокси)"
    require_node
    require_deps || return 1
    require_env || warn "сервер стартует, но авторизация аккаунтов работать не будет."
    if port_busy; then
        handle_busy_port || return 1
    fi
    _proxy=$(ensure_proxy) || return 1
    dim "  $(base_url)/v1    перезапуск при изменении src/    Ctrl+C — остановить"
    dim "  прокси: $(mask_proxy_url "$_proxy")"
    printf '\n'
    PROXY_URL="$_proxy" node --watch src/index.js
}

cmd_test() {
    head "Юнит-тесты"
    require_node
    require_deps || return 1
    npm test
}

cmd_smoke() {
    head "Сквозная проверка на живом аккаунте"
    require_node
    require_deps || return 1
    warn "скрипт логинится в реальный Telegram и пишет в «Избранное»."
    if ! port_busy; then
        fail "сервер не слушает $(base_url) — запустите его в другом терминале (./run.sh start)."
        return 1
    fi
    confirm "Продолжить?" || return 0
    printf '\n'
    BASE="$(base_url)/v1" node scripts/smoke.mjs
}

cmd_smoke_proxy() {
    _arg=${1-}
    if [ "$_arg" = "--reset" ] || [ "$_arg" = "-r" ] || [ "$_arg" = "--change" ] || [ "$_arg" = "--new" ]; then
        cached_proxy_clear
    elif [ -n "$_arg" ] && [ "$_arg" != "--proxy" ] && [ "$_arg" != "-p" ] && [ "$_arg" != "--with-proxy" ]; then
        cached_proxy_set "$_arg"
    fi
    head "Сквозная проверка на живом аккаунте (прокси)"
    require_node
    require_deps || return 1
    warn "скрипт логинится в реальный Telegram и пишет в «Избранное»."
    if ! port_busy; then
        fail "сервер не слушает $(base_url) — запустите его в другом терминале (./run.sh start:proxy)."
        return 1
    fi
    _proxy=$(ensure_proxy) || return 1
    confirm "Продолжить?" || return 0
    printf '\n'
    PROXY_URL="$_proxy" BASE="$(base_url)/v1" node scripts/smoke.mjs
}

cmd_proxy() {
    _action=${1-}
    _arg=${2-}

    case "$_action" in
        set)
            if [ -n "$_arg" ]; then
                _input="$_arg"
            else
                printf 'Введите URL прокси: '
                read -r _input || return 0
            fi
            _input=$(printf '%s' "$_input" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
            if [ -z "$_input" ]; then
                fail "пустой адрес прокси."
                return 1
            fi
            if ! printf '%s' "$_input" | grep -q '://'; then
                warn "в адресе нет схемы, предполагаю socks5://$_input"
                _input="socks5://$_input"
            fi
            cached_proxy_set "$_input"
            ok "прокси сохранён: $(mask_proxy_url "$_input")"
            ;;
        reset|clear|rm)
            cached_proxy_clear
            ok "кэш прокси очищен."
            ;;
        show)
            _cached=$(cached_proxy_get)
            if [ -n "$_cached" ]; then
                ok "кэшированный прокси: $(mask_proxy_url "$_cached")"
            else
                info "кэш прокси пуст."
            fi
            ;;
        "")
            head "Настройка прокси"
            _cached=$(cached_proxy_get)
            if [ -n "$_cached" ]; then
                info "  Текущий кэш: $(mask_proxy_url "$_cached")"
            else
                info "  Текущий кэш: (пусто)"
            fi
            _env_p=$(env_get PROXY_URL)
            if [ -n "$_env_p" ]; then
                dim "  В .env задан: $(mask_proxy_url "$_env_p")"
            fi
            printf '\n'
            printf '  1) Задать / изменить прокси\n'
            printf '  2) Сбросить (очистить кэш)\n'
            printf '  0) назад\n\n'
            printf 'Выбор: '
            read -r _pc || return 0
            case "$_pc" in
                1)
                    printf 'Введите URL прокси: '
                    read -r _input || return 0
                    _input=$(printf '%s' "$_input" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
                    if [ -n "$_input" ]; then
                        if ! printf '%s' "$_input" | grep -q '://'; then
                            warn "в адресе нет схемы, предполагаю socks5://$_input"
                            _input="socks5://$_input"
                        fi
                        cached_proxy_set "$_input"
                        ok "прокси сохранён: $(mask_proxy_url "$_input")"
                    else
                        warn "отменено (пустой ввод)."
                    fi
                    ;;
                2)
                    cached_proxy_clear
                    ok "кэш прокси очищен."
                    ;;
                *) return 0 ;;
            esac
            ;;
        *)
            if printf '%s' "$_action" | grep -q '://'; then
                cached_proxy_set "$_action"
                ok "прокси сохранён: $(mask_proxy_url "$_action")"
            else
                fail "неизвестное действие: $_action (доступны: set, reset, show)"
                return 1
            fi
            ;;
    esac
}

cmd_env() {
    head "Конфигурация"
    if [ ! -f "$ROOT/.env" ]; then
        warn ".env отсутствует."
        if confirm "Создать из .env.example?"; then
            cp "$ROOT/.env.example" "$ROOT/.env" && chmod 600 "$ROOT/.env"
            ok ".env создан."
        else
            return 0
        fi
    fi
    printf '  %-20s %s\n' "TELEGRAM_API_ID"  "$(mask "$(env_get TELEGRAM_API_ID)")"
    printf '  %-20s %s\n' "TELEGRAM_API_HASH" "$(mask "$(env_get TELEGRAM_API_HASH)")"
    printf '  %-20s %s\n' "ADMIN_TOKEN"      "$(mask "$(env_get ADMIN_TOKEN)")"
    printf '  %-20s %s\n' "HOST"             "$(env_get HOST 127.0.0.1)"
    printf '  %-20s %s\n' "PORT"             "$(env_get PORT 3111)"
    printf '  %-20s %s\n' "DATA_DIR"         "$(env_get DATA_DIR ./data)"
    printf '  %-20s %s\n' "LOG_UPDATES"      "$(env_get LOG_UPDATES false)"
    printf '  %-20s %s\n' "UPDATES_MAX_MB"   "$(env_get UPDATES_MAX_MB 50)"
    printf '  %-20s %s\n' "CORS_ORIGINS"     "$(env_get CORS_ORIGINS)"
    # В PROXY_URL живёт пароль от прокси — показываем маской, как и прочие секреты.
    printf '  %-20s %s\n' "PROXY_URL"        "$(mask "$(env_get PROXY_URL)")"
    printf '  %-20s %s\n' "PROXY_TIMEOUT"    "$(env_get PROXY_TIMEOUT 5)"
    printf '  %-20s %s\n' "PROXY_FROM_ENV"   "$(env_get PROXY_FROM_ENV false)"
    _cached_p=$(cached_proxy_get)
    if [ -n "$_cached_p" ]; then
        printf '  %-20s %s\n' "PROXY_CACHE"      "$(mask_proxy_url "$_cached_p")"
    fi
    printf '\n'
    dim "  правка: \$EDITOR .env    (секреты показаны маской)"
}

cmd_health() {
    head "Проверка живого сервера"
    command -v curl >/dev/null 2>&1 || die "curl не найден в PATH."
    _url="$(base_url)/v1/health"
    dim "  GET $_url"
    printf '\n'
    if curl_local "$_url"; then
        printf '\n'
        ok "сервер отвечает."
    else
        printf '\n'
        fail "нет ответа от $_url."
        return 1
    fi
}

cmd_doctor() {
    head "Диагностика окружения"

    if command -v node >/dev/null 2>&1; then
        _major=$(node -p 'process.versions.node.split(".")[0]')
        if [ "$_major" -ge 18 ]; then
            ok "Node.js $(node -v)"
        else
            fail "Node.js $(node -v) — требуется >= 18"
        fi
    else
        fail "Node.js не найден"
    fi

    command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || fail "npm не найден"

    [ -d "$ROOT/node_modules" ] && ok "node_modules на месте" || warn "node_modules отсутствует — нужен install"

    if [ -f "$ROOT/.env" ]; then
        ok ".env найден"
        [ -n "$(env_get TELEGRAM_API_ID)" ] && ok "TELEGRAM_API_ID задан" || fail "TELEGRAM_API_ID пуст"
        [ -n "$(env_get TELEGRAM_API_HASH)" ] && ok "TELEGRAM_API_HASH задан" || fail "TELEGRAM_API_HASH пуст"
        _host=$(env_get HOST 127.0.0.1)
        if [ "$_host" = "127.0.0.1" ] || [ "$_host" = "localhost" ]; then
            ok "HOST=$_host (только локальный доступ)"
        elif [ -n "$(env_get ADMIN_TOKEN)" ]; then
            ok "HOST=$_host, ADMIN_TOKEN задан"
        else
            fail "HOST=$_host при пустом ADMIN_TOKEN — POST /v1/accounts открыт наружу"
        fi
    else
        fail ".env отсутствует"
    fi

    _proxy=$(env_get PROXY_URL)
    _proxy_src="PROXY_URL"
    if [ -z "$_proxy" ] && [ "$(env_get PROXY_FROM_ENV false)" = "true" ]; then
        # Тот же порядок, что и в src/telegram/proxyUrl.js.
        for _name in https_proxy HTTPS_PROXY all_proxy ALL_PROXY http_proxy HTTP_PROXY; do
            eval "_value=\${$_name}"
            if [ -n "$_value" ]; then _proxy="$_value"; _proxy_src="$_name"; break; fi
        done
    fi
    if [ -n "$_proxy" ]; then
        # Схему и хост показать полезно, а всё до @ — это логин с паролем.
        ok "прокси из $_proxy_src: $(mask_proxy_url "$_proxy")"
    elif [ "$(env_get PROXY_FROM_ENV false)" = "true" ]; then
        warn "PROXY_FROM_ENV=true, но ни PROXY_URL, ни системные переменные не заданы"
    else
        ok "прокси не задан в .env — прямое подключение"
    fi

    _cached_p=$(cached_proxy_get)
    if [ -n "$_cached_p" ]; then
        ok "кэш прокси run.sh: $(mask_proxy_url "$_cached_p")"
    fi

    _data=$(env_get DATA_DIR ./data)
    [ -d "$ROOT/${_data#./}" ] && ok "каталог данных $_data" || warn "каталог данных $_data будет создан при старте"

    if port_busy; then
        warn "порт $(env_get PORT 3111) занят — сервер уже запущен?"
        port_report || dim "  кто именно — сказать нечем: lsof не найден в PATH"
    else
        ok "порт $(env_get PORT 3111) свободен"
    fi
}

cmd_clean() {
    head "Очистка"
    dim "  сессии аккаунтов (data/accounts.json) не трогаются."
    printf '\n'
    printf '  1) node_modules\n'
    printf '  2) лог обновлений data/updates.jsonl\n'
    printf '  3) кэш прокси run.sh\n'
    printf '  0) назад\n\n'
    printf 'Выбор: '
    read -r _c || return 0
    case "$_c" in
        1)
            [ -d "$ROOT/node_modules" ] || { warn "node_modules отсутствует."; return 0; }
            confirm "Удалить node_modules?" || return 0
            rm -rf "$ROOT/node_modules" && ok "node_modules удалён."
            ;;
        2)
            _log="$ROOT/$(env_get DATA_DIR ./data)/updates.jsonl"
            [ -f "$_log" ] || { warn "лог обновлений отсутствует."; return 0; }
            confirm "Удалить $_log?" || return 0
            rm -f "$_log" && ok "лог удалён."
            ;;
        3)
            _cp_file=$(proxy_cache_file)
            [ -f "$_cp_file" ] || { warn "кэш прокси отсутствует."; return 0; }
            confirm "Удалить кэш прокси?" || return 0
            cached_proxy_clear && ok "кэш прокси удалён."
            ;;
        *) return 0 ;;
    esac
}

# --------------------------------------------------------------------- меню

menu() {
    while :; do
        printf '\n%sapiGram%s %s%s%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$(base_url)" "$C_RESET"
        printf '\n'
        printf '  %s1%s) install       установить зависимости\n'                "$C_ACC" "$C_RESET"
        printf '  %s2%s) start         запустить сервер\n'                      "$C_ACC" "$C_RESET"
        printf '  %s3%s) start:proxy   запустить сервер с прокси\n'             "$C_ACC" "$C_RESET"
        printf '  %s4%s) dev           запустить с автоперезапуском\n'          "$C_ACC" "$C_RESET"
        printf '  %s5%s) dev:proxy     запустить с автоперезапуском (прокси)\n' "$C_ACC" "$C_RESET"
        printf '  %s6%s) test          юнит-тесты\n'                            "$C_ACC" "$C_RESET"
        printf '  %s7%s) smoke         сквозная проверка (живой аккаунт)\n'     "$C_ACC" "$C_RESET"
        printf '  %s8%s) proxy         настройка / сброс кэша прокси\n'         "$C_ACC" "$C_RESET"
        printf '  %s9%s) env           показать/создать .env\n'                 "$C_ACC" "$C_RESET"
        printf ' %s10%s) health        пинг запущенного сервера\n'              "$C_ACC" "$C_RESET"
        printf ' %s11%s) doctor        диагностика окружения\n'                 "$C_ACC" "$C_RESET"
        printf ' %s12%s) clean         очистка артефактов\n'                    "$C_ACC" "$C_RESET"
        printf '  %s0%s) выход\n'                                               "$C_ACC" "$C_RESET"
        printf '\nВыбор: '
        read -r choice || { printf '\n'; return 0; }
        case "$choice" in
            1|install)                               cmd_install ;;
            2|start)                                 cmd_start ;;
            3|"start:proxy"|start-proxy|start_proxy) cmd_start_proxy ;;
            4|dev)                                   cmd_dev ;;
            5|"dev:proxy"|dev-proxy|dev_proxy)       cmd_dev_proxy ;;
            6|test)                                  cmd_test ;;
            7|smoke)                                 cmd_smoke ;;
            8|proxy)                                 cmd_proxy ;;
            9|env)                                   cmd_env ;;
            10|health)                               cmd_health ;;
            11|doctor)                               cmd_doctor ;;
            12|clean)                                cmd_clean ;;
            0|q|Q|"")                                return 0 ;;
            *)                                       fail "неизвестный пункт: $choice" ;;
        esac
    done
}

usage() {
    printf 'apiGram — сборка и запуск\n\n'
    printf 'Использование: ./run.sh [команда]\n\n'
    printf '  install       установить зависимости (npm ci / npm install)\n'
    printf '  start         запустить сервер\n'
    printf '  start:proxy   запустить сервер с прокси\n'
    printf '  dev           запустить с автоперезапуском (node --watch)\n'
    printf '  dev:proxy     запустить с автоперезапуском через прокси\n'
    printf '  test          юнит-тесты\n'
    printf '  smoke         сквозная проверка на живом аккаунте\n'
    printf '  proxy         настройка / сброс кэшированного прокси\n'
    printf '  env           показать/создать .env\n'
    printf '  health        пинг запущенного сервера\n'
    printf '  doctor        диагностика окружения\n'
    printf '  clean         очистка артефактов\n\n'
    printf 'Без аргументов открывается интерактивное меню.\n'
}

case "${1-}" in
    "")                                  menu ;;
    install)                             cmd_install ;;
    start)
        case "${2-}" in
            --proxy|-p|--with-proxy)     cmd_start_proxy "${3-}" ;;
            *)                           cmd_start ;;
        esac
        ;;
    start:proxy|start-proxy|start_proxy) cmd_start_proxy "${2-}" ;;
    dev)
        case "${2-}" in
            --proxy|-p|--with-proxy)     cmd_dev_proxy "${3-}" ;;
            *)                           cmd_dev ;;
        esac
        ;;
    dev:proxy|dev-proxy|dev_proxy)       cmd_dev_proxy "${2-}" ;;
    test)                                cmd_test ;;
    smoke)
        case "${2-}" in
            --proxy|-p|--with-proxy)     cmd_smoke_proxy "${3-}" ;;
            *)                           cmd_smoke ;;
        esac
        ;;
    smoke:proxy|smoke-proxy|smoke_proxy) cmd_smoke_proxy "${2-}" ;;
    proxy)                               cmd_proxy "${2-}" "${3-}" ;;
    env)                                 cmd_env ;;
    health)                              cmd_health ;;
    doctor)                              cmd_doctor ;;
    clean)                               cmd_clean ;;
    -h|--help|help)                      usage ;;
    *)                                   fail "неизвестная команда: $1"; printf '\n'; usage; exit 1 ;;
esac
