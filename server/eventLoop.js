// server/eventLoop.js

const { getEventLoopOrder } = require("./helpers");

function runEventLoopVisualizer() {
  console.log("Start");

  // show how Node executes internally
  process.nextTick(() => {
    console.log("nextTick (microtask - highest priority)");
  });

  Promise.resolve().then(() => {
    console.log("Promise (microtask)");
  });

  setTimeout(() => {
    console.log("setTimeout (timers phase)");
  }, 0);

  setImmediate(() => {
    console.log("setImmediate (check phase)");
  });

  console.log("End");

  // helper-based capture (for understanding + testing)
  getEventLoopOrder((order) => {
    console.log("Captured Order from Helper:", order);
  });
}

module.exports = { runEventLoopVisualizer };

// run only if executed directly
if (require.main === module) {
  runEventLoopVisualizer();
}