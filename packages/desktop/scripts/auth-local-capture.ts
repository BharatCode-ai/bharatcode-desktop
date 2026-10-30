const target = process.env.BHARATCODE_AUTH_CAPTURE_URL
const secret = process.env.BHARATCODE_AUTH_CAPTURE_SECRET
if (!target || !secret || new URL(target).hostname !== "127.0.0.1" || Bun.argv.length !== 3) process.exit(1)
const response = await fetch(target, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ url: Bun.argv[2] }),
  redirect: "error",
  signal: AbortSignal.timeout(5000),
})
process.exit(response.ok ? 0 : 1)
