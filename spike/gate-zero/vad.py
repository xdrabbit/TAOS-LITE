import sys,wave,struct
for f in sys.argv[1:]:
  w=wave.open(f); n=w.getnframes(); d=struct.unpack('<%dh'%n,w.readframes(n)); r=w.getframerate()
  win=r//50; v=[i for i in range(0,n-win,win) if max(abs(x) for x in d[i:i+win])>1500]
  print(f, 'onset_ms',round(v[0]/r*1000),'offset_ms',round((v[-1]+win)/r*1000),'dur_ms',round(n/r*1000))
