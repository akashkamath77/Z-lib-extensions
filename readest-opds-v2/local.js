const { server } = require("./server");

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log("Readest Z-Library OPDS v2 listening on port " + port);
});
