const fs = require("fs");
const config = require("./config");

const net = require(config.irc.tls ? "tls" : "net");
let bouncerSocket = null;

if (config.irc.tls) {
  bouncerSocket = net.connect(config.irc.port, config.irc.address);
} else {
  bouncerSocket = new net.Socket();
}

let buffers = new Map();
let channels = new Map();
let clients = new Set();
let conn = false;

let host = ":bouncer.js";
let clientHost = null;
let motd = null;

let pingMsg = null;

bouncerSocket.broadcast = function (msg, e) {
  clients.forEach((c) => {
    if (c === e) return;
    c.write(msg, (err) => err && clients.delete(c));
  });
};

let capability = ":multi-prefix\r\n";

bouncerSocket.on("data", (data) => {
  let msg = data.toString("utf8").split(" ");
  if (!host) host = msg[0];

  let pmsg = data
    .toString("utf8")
    .split("\r\n")
    .filter((i) => i.startsWith("PING"))[0];
  if (pmsg) {
    bouncerSocket.write(`PONG ${pmsg.slice(5)}`);
    return;
  }

  if (msg[0].startsWith(":"))
    switch (msg.slice(1)[0]) {
      case "ERROR":
        console.error(msg.join(" "));
        bouncerSocket.broadcast(data);
        break;
      case "CAP":
        if (conn) return;
        if (msg[3].startsWith("LS")) {
          if (!msg.filter((i) => i.startsWith(capability)).length) return;
          bouncerSocket.write(`CAP REQ ${capability}`);
        } else if (msg[3].startsWith("ACK") && capability.startsWith(msg[4])) {
          bouncerSocket.write(`CAP END\r\n`);
          conn = true;

          setInterval(() => {
            pingMsg = "bouncer.js/" + Date.now();
            bouncerSocket.write("PING " + pingMsg);
          }, config.irc.pingInterval || 30000);

          console.log("Registration Completed.");
        }
        break;
      case "PRIVMSG":
        let buffer = buffers.get(msg[2]) || [];
        if (buffer.length > 100) buffer.slice(1);
        buffer.push(data);
        buffers.set(msg[2], buffer);
        bouncerSocket.broadcast(data);
        break;
      case "001":
        motd = data.toString("utf8");
        console.log(motd);
        console.log("Succesfully bouncing as", config.irc.username);

        if (config.irc.run)
          config.irc.run.forEach((cmd) => bouncerSocket.write(cmd));

        bouncerSocket.broadcast(data);
        break;
      case "JOIN":
        clientHost = msg[0];
        channels.set(msg[2], data);
        bouncerSocket.broadcast(data);
        break;
      case "PART":
        clientHost = msg[0];
        channels.delete(msg[2]);
        bouncerSocket.broadcast(data);
        break;
      case "PING":
        bouncerSocket.write(`PONG ${msg[1]}`);
        break;
      case "PONG":
        if (msg[2] === pingMsg) break;
      default:
        bouncerSocket.broadcast(data);
        break;
    }
});

bouncerSocket.on("close", () => process.exit(0));

// NodeJS TLS Module is confusing.
// The function is same as how net module does. Just it's for TLS connection.
// But knowing that the event name is different makes me fell how this damn difficult thing exist since beginning.

// I'm just writting what i could do here. No need to open issue about this. The peak of comedy i guess.
bouncerSocket.on((config.irc.tls ? "secureC" : "c") + "onnect", () => {
  console.log("Connected to IRC server.");
  bouncerSocket.write(
    "CAP LS 302\r\n" +
      "NICK " +
      config.irc.nickname +
      "\r\n" +
      "USER " +
      config.irc.username +
      " 0 " +
      bouncerSocket.address().hostname +
      " :" +
      config.irc.realname +
      "\r\n" +
      (config.irc.password ? `PASS ${config.irc.password}\r\n` : "")
  );
});

// Who knows that the bouncer will listen with TLS or no.
let bouncerOptions = {};

if (config.bouncer.tls)
  bouncerOptions = {
    key: fs.readFileSync(config.bouncer.tls.key),
    cert: fs.readFileSync(config.bouncer.tls.cert),
  };

let server = new require(config.bouncer.tls ? "tls" : "net").Server(
  bouncerOptions
);

server.on("connection", (socket) => {
  let reg = false;
  let cap = null;
  let ft = 0; // Failed tries
  let cap_didLS = false;
  let registrated = false;
  /*socket.on("data", (data) =>
    data
      .toString("utf8")
      .split("\r\n")
      .filter((i) => i.length)
      .forEach((d) => socket.emit("command", d))
  );*/

  socket.on("data", (data) => {
    let msg = data.toString("utf8").split(" ");
    switch (msg[0]) {
      case "CAP":
        if (
          (msg[1].startsWith("REQ") || msg[1].startsWith("END")) &&
          !registrated
        ) {
          cap = msg[2];
          if (!msg[1].startsWith("END")) {
            if (cap_didLS) {
              socket.write(`${host} CAP * ACK ${cap.slice(1)}\r\n`);
            } else {
              socket.write(`${host} CAP * NAK ${cap}\r\n`);
            }
            return;
          }

          registrated = true;
          if (motd) socket.write(motd);
          clients.add(socket);
          channels.forEach((ch) => socket.write(ch));
          buffers.forEach((buffer) => socket.write(buffer.join("\r\n")));
        } else if (msg[1].startsWith("LS") && !registrated) {
          cap_didLS = true;
          socket.write(`${host} CAP * LS ${capability}\r\n`);
        }

        break;
      case "PRIVMSG":
        let buffer = buffers.get(msg[1]) || [];
        if (buffer.length > config.bouncer.history_limit) buffer.slice(1);
        buffer.push(`${clientHost} ${data.toString("utf8")}`);
        buffers.set(msg[1], buffer);
        bouncerSocket.broadcast(`${clientHost} ${msg.join(" ")}`, socket);
        bouncerSocket.write(data);
        break;
      case "QUIT":
        // Ignore the command.
        // Forwarding to server will terminate the connection, so we close the socket instead.
        socket.destroy();
        break;
      default:
        bouncerSocket.write(data);
        break;
    }
  });

  socket.on("close", () => clients.delete(socket));
});

server.on("error", console.error);

server.listen(config.bouncer.port, config.bouncer.address);
if (!config.irc.tls) bouncerSocket.connect(config.irc.port, config.irc.address);

process.on("SIGINT", () => {
  console.log("Closing Connections... Please wait....");
  bouncerSocket.broadcast(":NOTE NOTICE :Shutting Down Bouncer");
  bouncerSocket.end("QUIT :\r\n");
  server.close();
});
