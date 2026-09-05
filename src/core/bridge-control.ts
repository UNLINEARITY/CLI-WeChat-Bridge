export type BridgeControlCommand =
  | { type: "status" }
  | { type: "resume"; target?: string }
  | { type: "new_session" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "confirm" }
  | { type: "deny" }
  | { type: "answer"; raw: string }
  | { type: "model"; target?: string }
  | { type: "plan"; enabled: boolean };

/** Parse the canonical control command grammar shared by all channels. */
export function parseBridgeControlCommand(
  text: string,
): BridgeControlCommand | null {
  const [rawCommand, ...rest] = text.trim().split(/\s+/);
  if (!rawCommand?.startsWith("/")) {
    return null;
  }

  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/status":
      return { type: "status" };
    case "/resume":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/new":
    case "/new-session":
      return { type: "new_session" };
    case "/stop":
      return { type: "stop" };
    case "/reset":
      return { type: "reset" };
    case "/confirm":
    case "/yes":
      return { type: "confirm" };
    case "/deny":
    case "/no":
      return { type: "deny" };
    case "/answer":
      return argument ? { type: "answer", raw: argument } : null;
    case "/model":
      return { type: "model", target: argument || undefined };
    case "/plan":
      if (!argument || argument.toLowerCase() === "on") return { type: "plan", enabled: true };
      if (argument.toLowerCase() === "off") return { type: "plan", enabled: false };
      return null;
    default:
      return null;
  }
}
