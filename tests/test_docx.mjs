import { Docx } from '../js/io/docx.js';
import fs from 'fs';
globalThis.atob = b => Buffer.from(b, 'base64').toString('binary');
globalThis.Blob = class { constructor(parts){ this._buf = Buffer.concat(parts.map(p=>Buffer.from(p))); } async arrayBuffer(){ return this._buf; } get size(){ return this._buf.length; } };

const d = new Docx();
d.heading('Memoria de Cálculo', 1);
d.paragraph('Documento de prueba con acentos: áéíóú ñ — comillas.');
d.heading('1. Tabla', 2);
d.table(['El.', 'N (kN)', 'D/C'], [['1','-12.3','0.45'],['2','5.0','0.88']]);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
d.image('data:image/png;base64,'+png, 'Figura de prueba');
const buf = Buffer.from(await d.blob().arrayBuffer());
fs.writeFileSync('test.docx', buf);
console.log('docx bytes:', buf.length, '| PK sig:', buf.slice(0,2).toString('hex'));
