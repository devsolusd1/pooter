// Serves a token metadata file and a 1x1 picture on 127.0.0.1, for a local launch rehearsal only.
//   node serve-metadata.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8765);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const meta = { name: "Hunch", symbol: "HUNCH", description: "local rehearsal", image: `http://127.0.0.1:${port}/hunch.png` };
createServer((req, res) => {
  if (req.url === "/metadata.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(meta)); }
  else if (req.url === "/hunch.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(req.method === "HEAD" ? undefined : png); }
  else { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`metadata on http://127.0.0.1:${port}/metadata.json`));
