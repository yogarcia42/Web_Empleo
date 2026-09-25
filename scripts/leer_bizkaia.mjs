import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
  septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12'
};

function ejecutar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, {
    encoding: 'utf8', maxBuffer: 50_000_000
  });
  if (resultado.error || resultado.status !== 0) {
    throw new Error(`${comando}: ${resultado.error?.message || resultado.stderr}`);
  }
  return resultado.stdout;
}

// El servidor de Bizkaia omite una CA intermedia. Se descarga la CA
// anunciada por su certificado y se valida con las raíces de Ubuntu.
function descargarIntermedia(destino) {
  return new Promise((resolve, reject) => {
    const peticion = get(
      'http://crt.sectigo.com/IzenpeRSAOVSSLCA.crt',
      { timeout: 20000 },
      respuesta => {
        if (respuesta.statusCode !== 200) {
          respuesta.resume();
          reject(new Error(`Certificado intermedio: HTTP ${respuesta.statusCode}`));
          return;
        }
        const partes = [];
        let longitud = 0;
        respuesta.on('data', parte => {
          longitud += parte.length;
          if (longitud > 200_000) {
            respuesta.destroy(new Error('Certificado intermedio demasiado grande'));
          } else {
            partes.push(parte);
          }
        });
        respuesta.on('error', reject);
        respuesta.on('end', () => {
          if (!longitud) return reject(new Error('Certificado intermedio vacío'));
          writeFileSync(destino, Buffer.concat(partes));
          resolve();
        });
      }
    );
    peticion.on('timeout', () => peticion.destroy(new Error('Tiempo agotado')));
    peticion.on('error', reject);
  });
}

function limpiar(texto) {
  return texto
    .replace(/([\p{L}])-\s+([\p{L}])/gu, '$1$2')
    .replace(/[\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extraerConvocatorias(texto, url, numero, fecha) {
  const paginas = texto.split('\f');
  const inicios = [];

  for (let i = 0; i < paginas.length; i++) {
    const lineas = paginas[i].split(/\r?\n/).map(x => x.trim());
    if (!lineas.slice(0, 12).includes('SECCIÓN II')) continue;

    const posicion = lineas.slice(0, 25).findIndex(
      x => /^(?:Ayuntamiento de |Diputaci[oó]n Foral de |Bilbao Ekintza|Consorcio de )/i.test(x)
    );
    if (posicion < 0) continue;

    let j = posicion + 1;
    while (j < lineas.length && !lineas[j]) j++;

    const titulo = [];
    for (; j < Math.min(lineas.length, posicion + 12) && lineas[j]; j++) {
      titulo.push(lineas[j]);
    }

    inicios.push({
      indice: i,
      lugar: lineas[posicion],
      titulo: limpiar(titulo.join(' '))
    });
  }

  const convocatorias = [];

  for (let i = 0; i < inicios.length; i++) {
    const actual = inicios[i];

    if (!/(?:bases de convocatoria|convocatoria de pruebas selectivas|bases reguladoras del proceso selectivo)/i.test(actual.titulo)) {
      continue;
    }
    if (/(?:feria|subvenci[oó]n|admitid[oa]s|excluid[oa]s|primer ejercicio|promoci[oó]n interna)/i.test(actual.titulo)) {
      continue;
    }

    const fin = inicios[i + 1]?.indice ?? paginas.length;
    const anuncio = limpiar(paginas.slice(actual.indice, fin).join(' '));

    if (!/turno de acceso libre general/i.test(anuncio)) continue;

    const plazo = anuncio.match(
      /(?:el\s+)?plazo de presentaci[oó]n de solicitudes ser[aá] de[^.]{10,500}\./i
    )?.[0];

    const puesto = anuncio.match(
      /1\.1\.\s*Denominaci[oó]n:\s*(.{5,180}?)\.\s*1\.2\./i
    )?.[1];

    if (!plazo || !puesto) {
      console.log(
        `Revisar anuncio en página ${actual.indice + 1}: puesto o plazo no detectado.`
      );
      continue;
    }
    
    const tasa = anuncio.match(
      /Tasa aplicable[^:]{0,65}:\s*(\d+,\d{2})\s*euros/i
    )?.[1];

    const sistema = anuncio.match(
      /selecci[oó]n se realizar[aá] mediante el sistema de ([^.]{2,60})\./i
    )?.[1];

    convocatorias.push({
      provincia: 'Bizkaia',
      lugar: actual.lugar,
      titulo: `1 plaza de ${puesto}`,
      sistema: sistema || '',
      tasas: tasa ? `${tasa} €` : '',
      plazo,
      boletin: numero,
      fecha,
      url: `${url}#page=${actual.indice + 1}`
    });
  }

  return convocatorias;
}

try {
  const ultimo = db.prepare(
    'SELECT numero, fecha, url FROM bizkaia ORDER BY fecha DESC, numero DESC LIMIT 1'
  ).get();

  if (!ultimo) {
    throw new Error('Bizkaia necesita un boletín anterior en la base');
  }

  const hoy = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

  const anio = ultimo.fecha.slice(0, 4);
  const mes = ultimo.fecha.slice(5, 7);
  const numero = ultimo.fecha === hoy ? ultimo.numero : ultimo.numero + 1;
  const codigo = String(numero).padStart(3, '0');

  const url = ultimo.fecha === hoy
    ? ultimo.url
    : `https://www.bizkaia.eus/lehendakaritza/Bao_bob/${anio}/${mes}/BOB-${anio}a${codigo}.pdf`;

  console.log(`Boletín ${numero}: ${url}`);

  const archivoLocal = process.argv[2] === '--probar-archivo'
    ? process.argv[3]
    : null;

  let texto;

  if (archivoLocal) {
    texto = ejecutar('pdftotext', ['-layout', archivoLocal, '-'])
      .normalize('NFC');
  } else {
    const der = join(temporal, 'izenpe.crt');
    const pem = join(temporal, 'izenpe.pem');
    const certificados = join(temporal, 'certificados.pem');
    const pdf = join(temporal, 'boletin.pdf');

    await descargarIntermedia(der);

    ejecutar('openssl', [
      'x509', '-inform', 'DER', '-in', der, '-out', pem
    ]);

    ejecutar('openssl', [
      'verify', '-CAfile', '/etc/ssl/certs/ca-certificates.crt', pem
    ]);

    writeFileSync(certificados, Buffer.concat([
      readFileSync('/etc/ssl/certs/ca-certificates.crt'),
      Buffer.from('\n'),
      readFileSync(pem)
    ]));

    console.log('Certificado verificado.');

    ejecutar('curl', [
      '-fsSL',
      '--max-time', '120',
      '--max-filesize', '100000000',
      '--cacert', certificados,
      '-o', pdf,
      url
    ]);

    if (readFileSync(pdf).subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('La respuesta no es un PDF');
    }

    texto = ejecutar('pdftotext', ['-layout', pdf, '-'])
      .normalize('NFC');
  }

  const cabecera = texto.slice(0, 5000);
  const numLeido = cabecera.match(
    /N[úu]m(?:ero)?\.?\s*[:º°]?\s*(\d+)/i
  );
  const fechaLeida = cabecera.match(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/i
  );

  if (!numLeido || !fechaLeida) {
    throw new Error('Cabecera no reconocida');
  }

  const fecha = `${fechaLeida[3]}-${meses[fechaLeida[2].toLowerCase()]}-${fechaLeida[1].padStart(2, '0')}`;

  if (
    Number(numLeido[1]) !== numero ||
    fecha.slice(0, 7) !== `${anio}-${mes}` ||
    fecha > hoy
  ) {
    throw new Error(
      `El boletín no coincide: n.º ${numLeido[1]}, ${fecha}`
    );
  }

  console.log(
    `PDF completo leído y verificado: n.º ${numero}, ${fecha}.`
  );

  const convocatorias = extraerConvocatorias(
    texto, url, numero, fecha
  );

  for (const oferta of convocatorias) {
    console.log(
      `${oferta.lugar}: ${oferta.titulo}; ${oferta.plazo}`
    );
  }

  console.log(
    `Convocatorias con plazo: ${convocatorias.length}.`
  );

  if (!archivoLocal) {
    const archivo = join(raiz, 'data', 'convocatorias.json');
    const anteriores = JSON.parse(readFileSync(archivo, 'utf8'));

    const otras = anteriores.fecha === fecha
      ? (anteriores.convocatorias || []).filter(
          x => x.provincia !== 'Bizkaia'
        )
      : [];

    writeFileSync(
      archivo,
      JSON.stringify({
        fecha,
        convocatorias: [...otras, ...convocatorias]
      }, null, 2) + '\n'
    );

    db.prepare(
      'INSERT OR IGNORE INTO bizkaia(numero, fecha, url) VALUES (?, ?, ?)'
    ).run(numero, fecha, url);
  }
} finally {
  db.close();
  rmSync(temporal, { recursive: true, force: true });
}
