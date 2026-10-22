import { createApp } from "./src/app.js";

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`PayTally running at http://localhost:${port}`);
});
