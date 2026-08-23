export async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

export async function getPrompt(
  argv: string[] = process.argv.slice(2),
): Promise<string> {
  const argPrompt = argv.join(' ').trim();
  return argPrompt || readStdin();
}
