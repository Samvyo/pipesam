const express = require("express");
const { getFilePath, createFileStream } = require("./helpers");

const app = express();

app.get("/stream", (req, res) => {
  const filePath = getFilePath();
  const stream = createFileStream(filePath);

  console.log("🚀 Streaming started...");

  // 👇 ADD THIS to see chunks
  stream.on("data", (chunk) => {
    console.log("Chunk size:", chunk.length);
  });

  stream.pipe(res);

  stream.on("end", () => {
    console.log("✅ Streaming finished");
  });

  stream.on("error", (err) => {
    console.error("❌ Error:", err.message);
    res.status(500).send("Error reading file");
  });
});

module.exports = app;

if (require.main === module) {
  app.listen(3000, () => {
    console.log("🚀 Server running on http://localhost:3000");
  });
}