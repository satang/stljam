const paths = {
  cube: 'M12 2.8 21 7.5v9L12 21.3 3 16.5v-9z M3 7.5l9 4.8 9-4.8 M12 12.3v9',
  fit: 'M9 4H4v5 M15 4h5v5 M20 15v5h-5 M4 15v5h5 M8.5 8.5h7v7h-7z',
  section: 'M12 3 21 8l-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  measure: 'M3 15.5 15.5 3l5.5 5.5L8.5 21z M7 11.5l2.4 2.4 M10.3 8.2l1.8 1.8 M13.6 4.9l2.4 2.4',
  point: 'M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0z M12 2.5v5 M12 16.5v5 M2.5 12h5 M16.5 12h5',
  region: 'M4 8V4h4 M10.8 4h2.4 M16 4h4v4 M20 10.8v2.4 M20 16v4h-4 M13.2 20h-2.4 M8 20H4v-4 M4 13.2v-2.4',
  compare: 'M4 5h16v14H4z M12 5v14 M7 9h2 M15 15h2',
  upload: 'M12 16V4 M7.5 8.5 12 4l4.5 4.5 M4 15v5h16v-5',
  eye: 'M2.7 12s3.2-5.5 9.3-5.5 9.3 5.5 9.3 5.5-3.2 5.5-9.3 5.5S2.7 12 2.7 12z M14.1 12a2.1 2.1 0 1 1-4.2 0 2.1 2.1 0 0 1 4.2 0z',
  eyeOff: 'M3 3l18 18 M8 7.3a10 10 0 0 1 4-.8c6.1 0 9.3 5.5 9.3 5.5a14 14 0 0 1-3.5 3.6 M15.8 16.8a10 10 0 0 1-3.8.7C5.9 17.5 2.7 12 2.7 12a14 14 0 0 1 3.4-3.5',
  add: 'M12 5v14 M5 12h14',
  send: 'M3.5 4.3 21 12 3.5 19.7l3-7.7z M6.5 12H21',
  edit: 'm4 20 4.5-1 11-11-3.5-3.5-11 11z M14 6.5l3.5 3.5',
  delete: 'M4.5 6.5h15 M9 6.5V4h6v2.5 M6.5 6.5l.8 13h9.4l.8-13 M10 10v6 M14 10v6',
  copy: 'M8 8h11v12H8z M15.5 8V4H4v12h4',
  close: 'm6 6 12 12 M18 6 6 18',
  check: 'm5 12 4.5 4.5L19 7'
};

const masks = new Map();

export function addIcon(element, name) {
  if (!masks.has(name)) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.lineWidth = 1.65;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(paths[name]));
    masks.set(name, `url(${canvas.toDataURL()})`);
  }
  element.classList.add('has-icon');
  element.style.setProperty('--icon-mask', masks.get(name));
  return element;
}
