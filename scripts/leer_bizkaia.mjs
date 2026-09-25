import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(raiz, 'web_empleo.sqlite'));
const temporal = mkdtempSync(join(tmpdir(), 'web-empleo-bizkaia-'));

const meses = {
  enero: '01', febrero: '02', marzo: '03', abril: '04',
  mayo: '05', junio: '06', julio: '07', agosto: '08',
  septiembre: '09', octubre: '10',
  noviembre: '11', diciembre: '12'
};

function ejecutar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, {
    encoding: 'utf8',
    maxBuffer: 10_000_000
  });

  if (resultado.error || resultado.status !== 0) {
    throw new Error(
      `${comando}: ${resultado.error?.message || resultado.stderr}`
    );
  }

  return resultado.stdout;
}

// Bizkaia omite un certificado intermedio. Lo obtenemos de la
// dirección anunciada por su certificado y lo verificamos con Ubuntu.
function descargarIntermedia(destino) {
  return new Promise((resolve, reject) => {
    const peticion = get(
      'http://crt.sectigo.com/IzenpeRSAOVSSLCA.crt',
      { timeout: 20000 },
      respuesta => {
        if (respuesta.statusCode !== 200) {
          respuesta.resume();
          reject(new Error(
            `Certificado intermedio: HTTP ${respuesta.statusCode}`
          ));
          return;
        }

        const partes = [];
        let longitud = 0;

        respuesta.on('data', parte => {
          longitud += parte.length;

          if (longitud > 200_000) {
            respuesta.destroy(new Error(
              'Certificado intermedio demasiado grande'
            ));
          } else {
            partes.push(parte);
          }
        });

        respuesta.on('error', reject);

        respuesta.on('end', () => {
          if (!longitud) {
            reject(new Error('Certificado intermedio vacío'));
            return;
          }

          writeFileSync(destino, Buffer.concat(partes));
          resolve();
        });
      }
    );

    peticion.on('timeout', () => {
      peticion.destroy(new Error('Tiempo agotado'));
    });
    peticion.on('error', reject);
  });
}

try {
  const ultimo = db.prepare(`
    SELECT numero, fecha
    FROM bizkaia
    ORDER BY fecha DESC, numero DESC
    LIMIT 1
  `).get();

  if (!ultimo) {
    throw new Error('Bizkaia necesita un boletín anterior en la base');
  }

  const anio = ultimo.fecha.slice(0, 4);
  const numero = ultimo.numero + 1;
  const mes = ultimo.fecha.slice(5, 7);
  const codigo = String(numero).padStart(3, '0');

  const url =
  `https://www.bizkaia.eus/lehendakaritza/Bao_bob/` +
  `${anio}/${mes}/BOB-${anio}a${codigo}.pdf`;

  console.log(`URL construida para el sumario ${numero}: ${url}`);

  const der = join(temporal, 'izenpe.crt');
  const pem = join(temporal, 'izenpe.pem');
  const certificados = join(temporal, 'certificados.pem');
  const pdf = join(temporal, 'sumario.pdf');

  await descargarIntermedia(der);

  ejecutar('openssl', [
    'x509', '-inform', 'DER', '-in', der, '-out', pem
  ]);

  ejecutar('openssl', [
    'verify',
    '-CAfile', '/etc/ssl/certs/ca-certificates.crt',
    pem
  ]);

  writeFileSync(certificados, Buffer.concat([
    readFileSync('/etc/ssl/certs/ca-certificates.crt'),
    Buffer.from('\n'),
    readFileSync(pem)
  ]));

  console.log('Certificado intermedio verificado.');

  ejecutar('curl', [
    '-fsSL',
    '--max-time', '45',
    '--max-filesize', '100000000',
    '--cacert', certificados,
    '-o', pdf,
    url
  ]);

  if (readFileSync(pdf).subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('La respuesta no es un PDF');
  }

  const texto = ejecutar(
    'pdftotext', ['-layout', pdf, '-']
  ).normalize('NFC');

  const cabecera = texto.slice(0, 5000);

  const numLeido = cabecera.match(
    /N[úu]m(?:ero)?\.?\s*[:º°]?\s*(\d+)/i
  );

  const fechaLeida = cabecera.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/i
  );

  if (!numLeido || !fechaLeida) {
    console.log('Cabecera PDF:', cabecera.slice(0, 800));
    throw new Error(
      'No se reconocen número y fecha en el sumario'
    );
  }

  const fecha =
    `${fechaLeida[3]}-` +
    `${meses[fechaLeida[2].toLowerCase()]}-` +
    fechaLeida[1].padStart(2, '0');

  const hoy = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  if (
    Number(numLeido[1]) !== numero ||
    fecha.slice(0, 7) !== `${anio}-${mes}` ||
    fecha > hoy
  ) {
    throw new Error(
      `El sumario no coincide: n.º ${numLeido[1]}, fecha ${fecha}`
    );
  }

  console.log(
    `Sumario leído y verificado: n.º ${numero}, ${fecha}.`
  );

  const lineas = texto.split(/\r?\n/).map(
    linea => linea.trim()
  );

  const convocatorias = [];
  let lugar = '';

  for (let i = 0; i < lineas.length; i++) {
    if (
      /^(?:Ayuntamiento de |Diputaci[oó]n Foral de |Mancomunidad de )/i
        .test(lineas[i])
    ) {
      lugar = lineas[i];
    }

    const titulo = [
      lineas[i], lineas[i + 1] || ''
    ].join(' ').replace(/\s+/g, ' ').trim();

    if (
      !/(?:convocatoria|bases|bolsa de trabajo)/i
        .test(lineas[i])
    ) continue;

    if (
      !/(?:plazas?|puestos?|bolsa de trabajo|proceso selectivo|oposici[oó]n)/i
        .test(titulo)
    ) continue;

    if (
      /(?:subvenci[oó]n|ayudas?|admitid[oa]s|excluid[oa]s|lista definitiva|primer ejercicio|nombramiento|promoci[oó]n interna|concurso de m[eé]ritos)/i
        .test(titulo)
    ) continue;

    if (convocatorias.some(x => x.titulo === titulo)) {
      continue;
    }

    convocatorias.push({
      provincia: 'Bizkaia',
      lugar,
      titulo,
      boletin: numero,
      fecha,
      url
    });
  }

  const archivo = join(
    raiz, 'data', 'convocatorias.json'
  );

  const anteriores = JSON.parse(
    readFileSync(archivo, 'utf8')
  );

  const delDia = anteriores.fecha === fecha
    ? anteriores.convocatorias || []
    : [];

  const otras = delDia.filter(
    x => x.provincia !== 'Bizkaia'
  );

  writeFileSync(
    archivo,
    JSON.stringify({
      fecha,
      convocatorias: [...otras, ...convocatorias]
    }, null, 2) + '\n'
  );

  console.log(
    `Convocatorias candidatas: ${convocatorias.length}.`
  );

  db.prepare(`
    INSERT INTO bizkaia(numero, fecha, url)
    VALUES (?, ?, ?)
  `).run(numero, fecha, url);

  console.log('Boletín guardado en la base de datos.');
} finally {
  db.close();
  rmSync(temporal, {
    recursive: true,
    force: true
  });
}
