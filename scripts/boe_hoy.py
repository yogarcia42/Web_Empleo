"""Publica en JSON las convocatorias locales del BOE, sección II-B, de hoy."""

import json
import re
import subprocess
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urljoin, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from xml.etree import ElementTree as ET

RAIZ = Path(__file__).resolve().parents[1]
SALIDA = RAIZ / 'data' / 'boe_hoy.json'
PROVINCIAS = json.loads((RAIZ / 'data' / 'provincias.json').read_text(encoding='utf-8'))
PROVINCIAS = ['Araba/Álava', *PROVINCIAS]
ALIAS = {'Álava': 'Araba/Álava', 'Araba': 'Araba/Álava',
         'Alicante/Alacant': 'Alicante', 'Castellón/Castelló': 'Castellón',
         'Valencia/València': 'Valencia', 'Illes Balears': 'Islas Baleares',
         'La Coruña': 'A Coruña', 'Vizcaya': 'Bizkaia', 'Guipúzcoa': 'Gipuzkoa',
         'Gerona': 'Girona', 'Lérida': 'Lleida', 'Orense': 'Ourense'}


def lista(valor):
    if not valor:
        return []
    return valor if isinstance(valor, list) else [valor]


def provincia_del_titulo(titulo):
    # Los anuncios locales del BOE indican la provincia entre paréntesis.
    for nombre in reversed(re.findall(r'\(([^()]+)\)', titulo)):
        nombre = nombre.strip()
        if nombre in PROVINCIAS:
            return nombre
        if nombre in ALIAS:
            return ALIAS[nombre]
    return None


def ente_del_titulo(titulo):
    """Elimina la fórmula 'Resolución de ...' del título del sumario."""
    encontrada = re.search(r'(?i)\b(?:del|de la|de los)\s+(.+?)\s*\([^()]+\)', titulo)
    if not encontrada:
        return 'Administración local'
    nombre = encontrada.group(1).strip()
    nombre = re.sub(r'(?i)^Ayuntamiento de\s+', '', nombre)
    return nombre


NUMEROS = {'una': '1', 'un': '1', 'dos': '2', 'tres': '3',
           'cuatro': '4', 'cinco': '5', 'seis': '6', 'siete': '7',
           'ocho': '8', 'nueve': '9', 'diez': '10'}


def plazas_del_anuncio(item):
    """Obtiene los puestos y el sistema de selección del texto oficial."""
    enlace = item.get('url_xml')
    if not enlace:
        raise ValueError(f'El anuncio {item["identificador"]} no tiene enlace XML')
    solicitud = Request(enlace, headers={'Accept': 'application/xml',
                                        'User-Agent': 'Web_Empleo/1.0'})
    with urlopen(solicitud, timeout=40) as respuesta:
        raiz = ET.parse(respuesta).getroot()
    parrafos = [' '.join(''.join(p.itertext()).split()) for p in raiz.findall('.//texto/p')]
    if not parrafos:
        raise ValueError(f'No se pudo leer el texto del anuncio {item["identificador"]}')
    expresion_sistema = re.compile(
        r'(?i)(?:por|mediante)(?: el sistema de)?\s+'
        r'(concurso[\s-]+oposición|oposición|concurso)\b')
    # En algunos anuncios el sistema figura solo en la frase que introduce
    # la lista de plazas, no en la descripción de cada una.
    sistema_general = None
    plazas = []
    for parrafo in parrafos:
        inicio = re.match(
            r'(?i)^(una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+'
            r'(plazas?|puestos?)\s+de\s+(.+)', parrafo)
        if not inicio:
            if not plazas and 'convocatoria para proveer' in parrafo.lower():
                sistema_general = expresion_sistema.search(parrafo)
            continue
        cantidad = NUMEROS.get(inicio.group(1).lower(), inicio.group(1))
        cargo = re.split(r'(?i),\s*(?:perteneciente|correspondiente|mediante|por el sistema|en turno)',
                         inicio.group(3), maxsplit=1)[0].rstrip(' .;,')
        sistema = expresion_sistema.search(parrafo) or sistema_general
        if not cargo:
            raise ValueError(f'No se identificó la plaza en {item["identificador"]}')
        tipo = 'plaza' if inicio.group(2).lower().startswith('plaza') else 'puesto'
        plazas.append({'puesto': f'{cantidad} {tipo if cantidad == "1" else tipo + "s"} de {cargo}',
                       'sistema': sistema.group(1).lower().replace(' ', '-') if sistema else None})
    if not plazas:
        print(f'BOE {item["identificador"]}: detalle no reconocido; consultar anuncio')
        return [{'puesto': 'Plazas o puestos: consultar BOE', 'sistema': None}]
    return plazas


class SumarioAraba(HTMLParser):
    """Recoge el organismo y el enlace castellano de cada anuncio del sumario."""

    def __init__(self):
        super().__init__()
        self.ente = ''
        self.titulo_depth = 0
        self.partes_ente = []
        self.href = None
        self.partes_enlace = []
        self.encabezados = []
        self.h2 = False
        self.partes_h2 = []
        self.anuncios = []

    def handle_starttag(self, etiqueta, atributos):
        atributos = dict(atributos)
        if etiqueta == 'h2':
            self.h2 = True
            self.partes_h2 = []
        if etiqueta == 'div':
            if 'titulo_bloque_resultados' in atributos.get('class', '').split():
                self.titulo_depth = 1
                self.partes_ente = []
            elif self.titulo_depth:
                self.titulo_depth += 1
        if etiqueta == 'a':
            href = atributos.get('href', '')
            if 'Resultado.aspx' in href and '_C.xml' in href:
                self.href = href
                self.partes_enlace = []

    def handle_data(self, texto):
        if self.h2:
            self.partes_h2.append(texto)
        if self.titulo_depth:
            self.partes_ente.append(texto)
        if self.href:
            self.partes_enlace.append(texto)

    def handle_endtag(self, etiqueta):
        if etiqueta == 'h2' and self.h2:
            self.encabezados.append(' '.join(''.join(self.partes_h2).split()))
            self.h2 = False
        if etiqueta == 'div' and self.titulo_depth:
            self.titulo_depth -= 1
            if self.titulo_depth == 0:
                self.ente = ' '.join(''.join(self.partes_ente).split())
        if etiqueta == 'a' and self.href:
            titulo = ' '.join(''.join(self.partes_enlace).split())
            if titulo:
                self.anuncios.append((self.ente, titulo, self.href))
            self.href = None


def candidato_araba(titulo):
    if re.search(r'(?i)lista|admitid|excluid|nombramiento|tribunal|ejercicio|resultados?'
                 r'|modificaci[oó]n|correcci[oó]n|subvenci[oó]n|ayudas?', titulo):
        return False
    return bool(re.search(r'(?i)convocatoria|bases|proceso selectivo|bolsa de trabajo', titulo)
                and re.search(r'(?i)plazas?|empleo|selecci[oó]n|ingreso|funcionari[oa]'
                              r'|oposici[oó]n|personal laboral|bolsa de trabajo', titulo))


def plazas_araba(titulo, pdf):
    solicitud = Request(pdf, headers={'User-Agent': 'Web_Empleo/1.0'})
    with urlopen(solicitud, timeout=45) as respuesta:
        contenido = respuesta.read(20_000_001)
    if len(contenido) > 20_000_000 or not contenido.startswith(b'%PDF'):
        raise ValueError(f'PDF inválido o demasiado grande: {pdf}')
    resultado = subprocess.run(['pdftotext', '-layout', '-', '-'], input=contenido,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=45, check=True)
    texto = resultado.stdout.decode('utf-8', errors='replace')
    # Se busca primero el número total convocado. El propio título puede dar
    # el nombre breve del puesto; el anuncio aporta el sistema de selección.
    plaza = re.search(r'(?i)\b(?:se convocan|se convoca|convocatoria para|cubrir)?\s*'
                      r'(\d+|una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+'
                      r'plazas?\s+de\s+([^\n]{3,200})', texto)
    sistema = re.search(r'(?i)(?:sistema|procedimiento)\s+de\s+'
                        r'(concurso[\s-]+oposici[oó]n|oposici[oó]n|concurso)\b', texto)
    if not plaza:
        print(f'Araba: plazas sin detalle verificable en {pdf}')
        return [{'puesto': 'Plazas: consultar anuncio', 'sistema': None}]
    cantidad = NUMEROS.get(plaza.group(1).lower(), plaza.group(1))
    cargo = re.split(r'(?i),\s*(?:por el sistema|mediante|seg[uú]n|grupo|turno)|\.',
                     plaza.group(2), maxsplit=1)[0].strip(' ,;')
    abreviado = re.search(r'(?i)\b(oficial/a\s+[^,.;]{3,65})', titulo)
    if abreviado:
        cargo = abreviado.group(1)
    if len(cargo) > 115:
        cargo = cargo[:112].rstrip(' ,;') + '…'
    nombre = 'plaza' if cantidad == '1' else 'plazas'
    modalidad = sistema.group(1).lower().replace(' ', '-') if sistema else None
    return [{'puesto': f'{cantidad} {nombre} de {cargo}', 'sistema': modalidad}]


def actualizar_araba(datos, fecha):
    dia, mes, anio = fecha[8:10], fecha[5:7], fecha[:4]
    portada = ('https://www.araba.eus/botha/Inicio/SGBO5001.aspx'
               f'?FechaBotha={dia}%2F{mes}%2F{anio}')
    try:
        solicitud = Request(portada, headers={'User-Agent': 'Web_Empleo/1.0'})
        with urlopen(solicitud, timeout=40) as respuesta:
            pagina = respuesta.read().decode('utf-8', errors='replace')
    except HTTPError as error:
        if error.code == 404:
            datos['araba'] = {'estado': 'sin_boletin'}
            return
        raise
    sumario = SumarioAraba()
    sumario.feed(pagina)
    encabezado = next((x for x in sumario.encabezados if 'Sumario del Boletin' in x), '')
    coincidencia = re.search(r'(?i)Sumario del Bolet[ií]n\s+n[º°]\s*(\d+)\s+del\s+'
                            r'.*?\b(\d{1,2})\s+de\s+'
                            r'(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)'
                            r'\s+de\s+(\d{4})', encabezado)
    if not coincidencia:
        # Sin edición, el portal devuelve un encabezado vacío con año 0001.
        if '0001' in encabezado or not encabezado:
            datos['araba'] = {'estado': 'sin_boletin'}
            print(f'BOTHA: sin boletín el {fecha}')
            return
        raise ValueError('No se pudo verificar la fecha y el número del BOTHA')
    meses = {m: i for i, m in enumerate(('enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                                         'julio', 'agosto', 'septiembre', 'octubre', 'noviembre',
                                         'diciembre'), 1)}
    fecha_publicada = f'{coincidencia[4]}-{meses[coincidencia[3].lower()]:02d}-{int(coincidencia[2]):02d}'
    if fecha_publicada != fecha:
        datos['araba'] = {'estado': 'sin_boletin'}
        print(f'BOTHA: no hay boletín del {fecha}; el sumario indica {fecha_publicada}')
        return
    numero = int(coincidencia[1])
    vistos = set()
    encontrados = 0
    for ente, titulo, href in sumario.anuncios:
        if not candidato_araba(titulo):
            continue
        archivo = unquote(parse_qs(urlsplit(href).query).get('File', [''])[0])
        if not re.fullmatch(rf'Boletines/{anio}/{numero:03d}/{anio}_{numero:03d}_\d{{5}}_C\.xml', archivo):
            raise ValueError(f'Anuncio con número o año inesperado en BOTHA: {archivo}')
        if archivo in vistos:
            continue
        vistos.add(archivo)
        pdf = urljoin('https://www.araba.eus/botha/', archivo[:-4] + '.pdf')
        lugar = re.sub(r'(?i)^AYUNTAMIENTO DE\s+', '', ente).strip() or 'Araba/Álava'
        datos['convocatorias'].append({
            'provincia': 'Araba/Álava', 'ente': lugar,
            'plazas': plazas_araba(titulo, pdf), 'url': pdf,
            'origen': 'BOTHA'})
        encontrados += 1
    datos['araba'] = {'estado': 'publicado', 'numero': numero, 'convocatorias': encontrados}
    print(f'BOTHA {numero}, {fecha}: {encontrados} convocatorias candidatas')


def leer_boe(fecha):
    url = 'https://www.boe.es/datosabiertos/api/boe/sumario/' + fecha.replace('-', '')
    solicitud = Request(url, headers={'Accept': 'application/json',
                                      'User-Agent': 'Web_Empleo/1.0'})
    try:
        with urlopen(solicitud, timeout=40) as respuesta:
            datos = json.load(respuesta)
    except HTTPError as error:
        if error.code == 404:
            return {'fecha': fecha, 'estado': 'sin_boe', 'convocatorias': []}
        raise
    if str(datos['status']['code']) != '200':
        raise ValueError('El BOE ha devuelto un error')
    sumario = datos['data']['sumario']
    if sumario['metadatos']['fecha_publicacion'] != fecha.replace('-', ''):
        raise ValueError('La fecha del sumario no coincide con hoy')
    ofertas = []
    vistos = set()
    for diario in lista(sumario.get('diario')):
        for seccion in lista(diario.get('seccion')):
            if seccion.get('codigo') != '2B':
                continue
            for departamento in lista(seccion.get('departamento')):
                if departamento.get('nombre', '').upper() != 'ADMINISTRACIÓN LOCAL':
                    continue
                for epigrafe in lista(departamento.get('epigrafe')):
                    for item in lista(epigrafe.get('item')):
                        titulo = item.get('titulo', '')
                        provincia = provincia_del_titulo(titulo)
                        referencia = item.get('identificador')
                        if not provincia or not referencia or referencia in vistos:
                            continue
                        vistos.add(referencia)
                        ofertas.append({'provincia': provincia,
                                        'ente': ente_del_titulo(titulo),
                                        'plazas': plazas_del_anuncio(item),
                                        'url': item.get('url_html') or
                                        f'https://www.boe.es/diario_boe/txt.php?id={referencia}'})
    return {'fecha': fecha, 'estado': 'publicado', 'convocatorias': ofertas}


if __name__ == '__main__':
    hoy = datetime.now(ZoneInfo('Europe/Madrid')).date().isoformat()
    contenido = leer_boe(hoy)
    actualizar_araba(contenido, hoy)
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(contenido, ensure_ascii=False, indent=2) + '\n',
                      encoding='utf-8')
    print(f'BOE {hoy}: {len(contenido["convocatorias"])} convocatorias locales')
