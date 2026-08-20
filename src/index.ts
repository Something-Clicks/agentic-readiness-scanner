import { config } from "./config.ts";
import { createServer } from "./http/server.ts";

const app = createServer();

app.listen(config.port, () => {
  console.log(`Scan is listening on http://localhost:${config.port}`);
  console.log(`Fetching as: ${config.userAgent}`);
  console.log(`Try: curl "http://localhost:${config.port}/scan?url=example.com&format=text"`);
});
