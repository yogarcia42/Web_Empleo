"""Publica en JSON las convocatorias locales del BOE, sección II-B, de hoy."""

import json
import re
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

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
                        ofertas.append({'provincia': provincia, 'titulo': titulo,
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
