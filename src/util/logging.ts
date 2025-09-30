const buffer: any[] = [];

export async function logEvent(event: string, data: Record<string, any> = {}) {
  const payload = { t: new Date().toISOString(), event, ...data };
  buffer.push(payload);
  if (buffer.length > 50) buffer.shift(); // keep last 50

  console.log(JSON.stringify(payload));
}

export function getRecentLogs(n = 5) {
  return buffer.slice(-n);
}
