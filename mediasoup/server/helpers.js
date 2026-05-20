// server/helpers.js

const fs = require("fs");
const path = require("path");

// helper 1
function getFilePath() {
  return path.join(__dirname, "../bigfile.txt");
}

// helper 2
function createFileStream(filePath) {
  return fs.createReadStream(filePath);
}

// helper 3 (FULL event loop capture)
function getEventLoopOrder(callback) {
  let order = [];

  // microtasks
  process.nextTick(() => order.push("nextTick"));

  Promise.resolve().then(() => order.push("promise"));

  // macrotasks
  setTimeout(() => {
    order.push("setTimeout");
  }, 0);

  setImmediate(() => {
    order.push("setImmediate");
  });

  // wait enough time to capture all
  setTimeout(() => {
    callback(order);
  }, 20);
}

module.exports = {
  getFilePath,
  createFileStream,
  getEventLoopOrder
};