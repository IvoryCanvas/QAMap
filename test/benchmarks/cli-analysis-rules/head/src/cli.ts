const [command, ...args] = process.argv.slice(2);

if (command === "inspect" && args.includes("--format=json")) {
  process.stdout.write(JSON.stringify({ status: "ok" }));
} else {
  process.stderr.write("usage: inspect --format=json");
  process.exitCode = 2;
}
