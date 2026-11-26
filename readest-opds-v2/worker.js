import serverModule from "./server.js";
import { httpServerHandler } from "cloudflare:node";

// Cloudflare's Node.js HTTP compatibility layer adapts this server
// to the Workers fetch runtime. No machine or open port is required.
const server = serverModule.server;

export default httpServerHandler(server);
