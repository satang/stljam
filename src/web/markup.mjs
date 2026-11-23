export const dimensionLabel = value => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} mm`;

export function drawMarkup(ctx, { ruler, region, drag }) {
  const point = (p, radius, color) => {
    ctx.beginPath();
    ctx.arc(...p, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  const regionColor = '#7ee8cb';
  if (region || drag) {
    const corners = drag || region;
    ctx.beginPath();
    ctx.moveTo(...corners[0]);
    corners.slice(1).forEach(p => ctx.lineTo(...p));
    ctx.closePath();
    ctx.fillStyle = '#7ee8cb24';
    ctx.fill();
    ctx.strokeStyle = regionColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!ruler) return;
  const { a, b, text } = ruler;
  const color = '#ffd077';
  if (b) {
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#0b141c';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  for (const [p, label] of [[a, 'A'], [b, 'B']]) {
    if (!p) continue;
    point(p, 7, '#0b141c');
    point(p, 4.5, color);
    ctx.font = '600 12px system-ui';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#0b141c';
    ctx.strokeText(label, p[0] + 8, p[1] - 7);
    ctx.fillStyle = color;
    ctx.fillText(label, p[0] + 8, p[1] - 7);
  }
  if (!b) return;
  const x = (a[0] + b[0]) / 2;
  const y = (a[1] + b[1]) / 2 - 18;
  ctx.font = '600 13px system-ui';
  const width = ctx.measureText(text).width + 18;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - 13, width, 24, 6);
  ctx.fillStyle = '#0b141c';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x - (width - 18) / 2, y + 3);
}
