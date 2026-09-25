import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const db=new DatabaseSync(join(root,'web_empleo.sqlite'));
const months={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
const last=db.prepare('SELECT numero,fecha FROM araba ORDER BY fecha DESC,numero DESC LIMIT 1').get();
if(!last)throw Error('La tabla de Araba necesita un boletín de partida');
const year=Number(last.fecha.slice(0,4)),num=last.numero+1,id=String(num).padStart(3,'0');
const url=`https://www.araba.eus/botha/Boletines/${year}/${id}/${year}_${id}_S_C.pdf`;
console.log(`Construida URL del siguiente boletín (${num}): ${url}`);
try{
 const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(response.status===404){console.log('Aún no existe el siguiente boletín; no se modifica la base.');process.exit(0);}
 if(!response.ok||!response.headers.get('content-type')?.toLowerCase().includes('pdf'))throw Error(`El boletín no devolvió un PDF: HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());
 if(bytes.length>10_000_000||bytes.subarray(0,4).toString()!=='%PDF')throw Error('PDF inválido o demasiado grande');
 const output=spawnSync('pdftotext',['-layout','-','-'],{input:bytes,maxBuffer:10_000_000,encoding:'utf8'});
 if(output.status!==0)throw Error(`No se pudo leer el PDF: ${output.stderr}`);
 const text=output.stdout.normalize('NFC');
 const found=text.match(/Número\s+(\d+)/i);
 const date=text.match(/\b(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) de (\d{4})\b/i);
 if(!found||!date||Number(found[1])!==num||Number(date[3])!==year)throw Error(`La portada no coincide con el número ${num} y año ${year}`);
 const iso=`${year}-${String(months[date[2].toLowerCase()]).padStart(2,'0')}-${date[1].padStart(2,'0')}`;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(iso>today)throw Error(`La fecha del boletín ${iso} es futura`);
 // El sumario separa cada anuncio con su código de cinco dígitos. Solo se muestran convocatorias nuevas de acceso libre.
 const lines=text.split(/\r?\n/).map(s=>s.trim().replace(/\x08/g,' '));
 const entries=[];let place='';let buffer='';
 for(const line of lines){
  if(/^AYUNTAMIENTO DE |^DIPUTACI[ÓO]N FORAL DE /i.test(line))place=line;
  if(!line||/^(BOLETÍN OFICIAL|DEL TERRITORIO|DE ÁLAVA|SUMARIO|NÚMERO|www\.araba|D\.L\.|ISSN|I -|II -|III -)/i.test(line))continue;
  buffer+=(buffer.endsWith('-')?'':' ')+line;
  buffer=buffer.replace(/-\s+([a-záéíóú])/gi,'$1');
  const code=buffer.match(/(?:20\d{2}-\d{5})\s*$/);
  if(code){
   const title=buffer.replace(/\.{3,}.*$/,'').replace(/\s+20\d{2}-\d{5}\s*$/,'').trim();
   if(/(?:convocatoria|bases|plazas?|bolsa de trabajo|oposici[oó]n)/i.test(title)&&/(?:plazas?|bolsa de trabajo|oposici[oó]n|proceso selectivo)/i.test(title)&&!/(?:subvenci[oó]n|ayudas?|lista definitiva|personas admitidas|primer ejercicio|resultados?|nombramiento)/i.test(title))entries.push({provincia:'Araba/Álava',lugar:place,titulo:title,boletin:num,fecha:iso,url});
   buffer='';
  }
 }
 db.prepare('INSERT INTO araba(numero,fecha,url) VALUES(?,?,?)').run(num,iso,url);
 writeFileSync(join(root,'data','convocatorias.json'),JSON.stringify({fecha:iso,convocatorias:entries},null,2)+'\n');
 console.log(`PDF leído y portada verificada: n.º ${num}, ${iso}. Convocatorias candidatas: ${entries.length}.`);
}finally{db.close();}
