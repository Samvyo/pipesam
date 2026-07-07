const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",

    info: {
      title: "AI Meeting Assistant API",
      version: "1.0.0",
      description:
        "REST APIs for the AI Meeting Assistant built with MediaSoup and Pipecat."
    },

    servers: [
      {
        url: "https://localhost:3000"
      }
    ],

    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Room not found" }
          }
        }
      }
    }
  },

  apis: ["./server.js"]
};

module.exports = swaggerJsdoc(options);