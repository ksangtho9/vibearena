(globalThis as never as Record<string, unknown>).document = {
  createElement: () => ({ width: 1, height: 1, getContext: () => ({ fillStyle: "#000", clearRect() {}, fillRect() {}, getImageData: () => ({ data: [128,128,128,255] }) }) }),
};
const { bonesFor, createAnimator, ATTACK_TIMINGS, FINISHER_TIMINGS } = await import("./client/src/game/animation");
const FAMILIES: [string, string][] = [
  ["slash", "sword"], ["chop", "axe"], ["thrust", "spear"], ["reap", "scythe"],
  ["crack", "whip"], ["bash", "shield"], ["punch", "fist"], ["cast", "staff"],
];
const out: Record<string, unknown[]> = {};
const issues: string[] = [];
for (const [style, form] of FAMILIES) {
  out[style] = [];
  for (let variant = 0; variant < 4; variant++) {
    const T = variant === 3 ? (FINISHER_TIMINGS as never as Record<string, { total: number; windup: number }>)[style] : ATTACK_TIMINGS[style as never];
    const anim = createAnimator(bonesFor(1));
    const base = {
      rootX: 400, rootY: 300, vx: 0, vy: 0, grounded: true, facing: 1 as const, moving: false,
      alive: true, blocking: false, weaponForm: form as never, weaponSize: "medium" as const,
      weaponType: "melee" as const, castTimer: 0, hitstunTimer: 0, launchedTimer: 0, groundY: 344, time: 0,
    };
    let t = 0;
    for (let i = 0; i < 40; i++) { t += 1/60; anim.update(1/60, { ...base, time: t, attackElapsed: -1 }); }
    let tipLowest = -1e9, contactA = 0, endA = 0, sweep = 0, prevA: number | null = null;
    for (let e = 0; e <= T.total + 1e-9; e += 1/120) {
      t += 1/60;
      const fr = anim.update(1/60, { ...base, time: t, attackElapsed: Math.min(e, T.total), comboVariant: variant });
      tipLowest = Math.max(tipLowest, fr.skeleton.handR.y + Math.sin(fr.weaponAngle) * 42);
      if (Math.abs(e - T.windup) < 1/119) contactA = fr.weaponAngle;
      if (prevA !== null) sweep += Math.abs(fr.weaponAngle - prevA);
      prevA = fr.weaponAngle;
      endA = fr.weaponAngle;
    }
    const tipVsFeet = Math.round(tipLowest - 343);
    const row = { v: variant, contact: +contactA.toFixed(2), end: +endA.toFixed(2), sweep: +sweep.toFixed(1), tipVsFeet };
    out[style].push(row);
    if (tipVsFeet > 2) issues.push(`${style}#${variant} floor-stab tip ${tipVsFeet}`);
    if (Math.abs(endA - (-0.55)) > 0.12) issues.push(`${style}#${variant} settle off (${endA.toFixed(2)})`);
  }
  // Distinctness: contact angles per variant should differ.
  const contacts = (out[style] as { contact: number }[]).map(r => Math.round(r.contact * 4));
  if (new Set(contacts.slice(0, 3)).size < 3 && style !== "thrust" && style !== "bash") {
    issues.push(`${style} variants not distinct (${contacts.join(",")})`);
  }
}
console.log(JSON.stringify({ issues, out }, null, 1));
