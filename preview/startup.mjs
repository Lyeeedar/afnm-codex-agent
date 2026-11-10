export function startupTimeout(env=process.env) {
  const timeout=Number(env.PREVIEW_READY_TIMEOUT_MS ?? 240000);
  if(!Number.isFinite(timeout) || timeout<=0)throw new Error('PREVIEW_READY_TIMEOUT_MS must be a positive number');
  return timeout;
}
