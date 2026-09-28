// Serves evals/site on 0.0.0.0 and prints the port. A separate process,
// because the Run drives agent-browser synchronously and would block an
// in-process server from ever answering.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const site = new URL("./site/", import.meta.url);
const server = createServer((req, res) => {
  const name = req.url.split("?")[0].replace(/^\/$/, "/index.html").replace(/^\//, "");
  let body;
  try {
    body = readFileSync(new URL(name, site));
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(body);
});
server.listen(0, "0.0.0.0", () => console.log(server.address().port));
