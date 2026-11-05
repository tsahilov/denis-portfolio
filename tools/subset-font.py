import sys
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
root = Path(__file__).resolve().parent.parent
source = root / 'fonts/InterVariable.woff2'
font = TTFont(source)
print({k: getattr(font['OS/2'], k) for k in ['sTypoAscender','sTypoDescender','sTypoLineGap','sxHeight']},font['head'].unitsPerEm)
options = subset.Options()
options.flavor = 'woff2'
options.layout_features = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=list(range(0x100)) + list(range(0x400, 0x460)) + list(range(0x2000, 0x2070)) + [0x490, 0x491, 0x20ac, 0x20bd, 0x2116, 0x2122, 0x2212, 0x2190, 0x2192])
subsetter.subset(font)
target = root / 'fonts/InterVariable-portfolio.woff2'
font.save(target)
print(source.stat().st_size, '->', target.stat().st_size)
