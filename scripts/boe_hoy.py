"""Publica en JSON las convocatorias locales del BOE, sección II-B, de hoy."""

import json
import re
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
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
        r'(?i)(?:por|mediante) el sistema de\s+(concurso[\s-]+oposición|oposición|concurso)\b')
    # En algunos anuncios el sistema figura solo en la frase que introduce
    # la lista de plazas, no en la descripción de cada una.
    sistema_general = None
    plazas = []
    for parrafo in parrafos:
        inicio = re.match(r'(?i)^(una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+plazas?\s+de\s+(.+)', parrafo)
        if not inicio:
            if not plazas and 'convocatoria para proveer' in parrafo.lower():
                sistema_general = expresion_sistema.search(parrafo)
            continue
        cantidad = NUMEROS.get(inicio.group(1).lower(), inicio.group(1))
        cargo = re.split(r'(?i),\s*(?:perteneciente|correspondiente|mediante|por el sistema|en turno)',
                         inicio.group(2), maxsplit=1)[0].rstrip(' .;,')
        sistema = expresion_sistema.search(parrafo) or sistema_general
        if not cargo:
            raise ValueError(f'No se identificó la plaza en {item["identificador"]}')
        plazas.append({'puesto': f'{cantidad} {"plaza" if cantidad == "1" else "plazas"} de {cargo}',
                       'sistema': sistema.group(1).lower().replace(' ', '-') if sistema else None})
    if not plazas:
        raise ValueError(f'No se encontraron las plazas en {item["identificador"]}')
    return plazas


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
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    SALIDA.write_text(json.dumps(contenido, ensure_ascii=False, indent=2) + '\n',
                      encoding='utf-8')
    print(f'BOE {hoy}: {len(contenido["convocatorias"])} convocatorias locales')
