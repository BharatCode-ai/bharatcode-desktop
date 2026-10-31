// Adversarial cases adapted from BharatCode-ai/bharatcode-desktop #67/#68.
// Original contributors: Siva Rama Krishna Reddy Padala (@Krish6115) and
// @prashilthul. Latest reviewed fixture source: d1034e3f38d30287874230bc099f517d37e8068d.
// These now exercise the final allowlisted archive, rather than a second redactor.
export const supportPrivacyCases: [string, string][] = [
  ["Authorization: Token abcdef1234567890SECRETVALUE", "abcdef1234567890SECRETVALUE"],
  ['{"authorization": "Token abcdef1234567890SECRETVALUE"}', "abcdef1234567890SECRETVALUE"],
  [
    '{"role": "user", "content": "private user prompt text that must not leak"}',
    "private user prompt text that must not leak",
  ],
  ["git clone https://github.com/my-org/private-repo.git", "private-repo"],
  ["git remote add origin git@github.com:my-org/private-repo.git", "private-repo"],
  ["origin https://token123@github.com/my-org/private-repo.git", "token123"],
  ["Authorization: Bearer abc123", "abc123"],
  ["Cookie: session=abcdef123456; other=zzz", "abcdef123456"],
  ["Set-Cookie: sid=SESSIONVALUE99; HttpOnly", "SESSIONVALUE99"],
  ["x-api-key: KEY1234567890abc", "KEY1234567890abc"],
  [
    `jwt ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"].join(".")}`,
    "eyJzdWIi",
  ],
  [`${["github", "pat"].join("_")}_11ABCDEFG0abcdefghijklmnop`, `${["github", "pat"].join("_")}_11ABCDEFG0`],
  [`AWS_ACCESS_KEY_ID=${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`, ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
  ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
  ["GET /cb?code=abc123XYZsecret&state=q", "abc123XYZsecret"],
  ["?api-key=KEY12345678", "KEY12345678"],
  ['{"password": "my pass phrase"}', "pass phrase"],
  ['{"password":"ab\\"cd"}', "cd"],
  ["https://user:p@ss:word@host/x", "ss:word"],
  [`key ${["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("")}`, ["AIza", "SyA1234567890"].join("")],
  ["key sk-or-v1-abc123", "abc123"],
  ["contact bob@example.com", "bob@example.com"],
  ["from 192.168.1.23", "192.168.1.23"],
  ["mac aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"],
  ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh", "MIIEvQIBADANBgkqh"],
  ["/root/.ssh/id_rsa", "/root"],
]
