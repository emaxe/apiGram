import { createHttpApp } from "./server/http.js";
import { attachWs } from "./server/ws.js";
import { config } from "./config.js";

config.assertCredentials();

const app = createHttpApp();
const server = app.listen(config.port, config.host, () => {
    console.log(`apiGram listening on http://${config.host}:${config.port}`);
});

attachWs(server);

function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);