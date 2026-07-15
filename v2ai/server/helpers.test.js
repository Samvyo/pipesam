const fs = require("fs");
const path = require("path");

const {
  getFilePath,
  createFileStream,
  getEventLoopOrder
} = require("./helpers");

describe("Helper Functions", () => {

  // ✅ Test 1
  test("should return correct file path", () => {
    const result = getFilePath();
    expect(result).toContain("bigfile.txt");
  });

  // ✅ Test 2
  test("should create a readable stream", () => {
    const filePath = path.join(__dirname, "../bigfile.txt");
    const stream = createFileStream(filePath);

    expect(stream).toBeInstanceOf(fs.ReadStream);
  });

  // ✅ Test 3 (UPDATED)
  test("should execute all event loop phases", (done) => {
    getEventLoopOrder((order) => {
      try {
        expect(order).toContain("nextTick");
        expect(order).toContain("promise");
        expect(order).toContain("setTimeout");
        expect(order).toContain("setImmediate");

        done();
      } catch (error) {
        done(error);
      }
    });
  });

});