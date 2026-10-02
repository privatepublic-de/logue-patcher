import sys, zlib, struct, zipfile
def unpack7(b):
    out=[]
    for i in range(0,len(b),8):
        g=b[i:i+8]; h=g[0]
        for j,x in enumerate(g[1:]): out.append(x | (0x80 if h>>j&1 else 0))
    return bytes(out)
line=[l for l in open(sys.argv[1]) if '51 4A' in l][0]
m=bytes(int(x,16) for x in line.split('] ')[1].split())
print('module',m[7],'slot',m[8])
d=unpack7(m[9:-1])
size,crc=struct.unpack('<II',d[:8]); body=d[8:]
print('decoded',len(d),'size',size,'len(body)',len(body),'crc',hex(crc),'zlib crc(body[:size])',hex(zlib.crc32(body[:size])))
z=zipfile.ZipFile(sys.argv[2]); pay=z.read([n for n in z.namelist() if n.endswith('payload.bin')][0])
print('payload.bin',len(pay),'found at',body.find(pay[:64]))
open('body.bin','wb').write(body[:size])
