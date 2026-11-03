# Generates SAMPLE (synthetic) files. No real patient, Rx, pharmacy or employer data.
import csv, json, math, random, datetime as dt
random.seed(20261103)
G={"Cairo":(30.04,31.24),"Giza":(30.01,31.21),"Alexandria":(31.20,29.92),"Qalyubia":(30.41,31.18),"Dakahlia":(31.04,31.38),"Sharqia":(30.59,31.50),"Gharbia":(30.79,30.99),"Aswan":(24.09,32.90),"Assiut":(27.18,31.18),"Luxor":(25.69,32.64)}
start=dt.date(2026,6,1); days=90
cats={"respiratory":120,"gastrointestinal":80,"allergy":60,"heat_illness":30}
sales=[];env=[];work=[]
for g in G:
  scale=2.0 if g in("Cairo","Giza") else 1.0
  for d in range(days):
    day=start+dt.timedelta(d); wk=1.15 if day.weekday() in(5,6) else 1.0
    heat = g in("Aswan","Luxor","Assiut") and 78<=d<=84
    dust = g in("Cairo","Giza","Qalyubia") and 72<=d<=76
    gi = g=="Alexandria" and 80<=d<=86
    t=30+ (6 if g in("Aswan","Luxor") else 0)+3*math.sin(d/14)+random.gauss(0,1)+(7 if heat else 0)
    pm=35+random.gauss(0,6)+(80 if dust else 0)
    env.append([day,g,round(t,1),round(max(pm,5),1),round(40+random.gauss(0,8))])
    for c,b in cats.items():
      m=1.0
      if c=="heat_illness" and heat: m=3.0
      if c=="respiratory" and dust: m=1.9
      if c=="allergy" and dust: m=1.6
      if c=="gastrointestinal" and gi: m=2.2
      sales.append([day,g,c,max(0,round(random.gauss(b*scale*wk*m,math.sqrt(b*scale)*1.2)))])
    hc=400*scale; ab=hc*0.03*(1.8 if (heat or dust or gi) else 1)+random.gauss(0,3)
    work.append([day,g,int(hc),max(0,round(ab)),max(0,round(ab*0.2+random.gauss(0,1)))])
def w(n,h,rows):
  with open(f"public/samples/{n}.csv","w",newline="") as f:
    x=csv.writer(f); x.writerow(h); [x.writerow(r) for r in rows]
w("SAMPLE_pharmacy_sales",["date","governorate","category","units"],sales)
w("SAMPLE_environment",["date","governorate","temp_c","pm25","humidity"],env)
w("SAMPLE_workplace",["date","governorate","headcount","absences","heat_or_breathing_complaints"],work)
json.dump({"_label":"SAMPLE SYNTHETIC DATA - not real","rows":[dict(zip(["date","governorate","temp_c","pm25","humidity"],[str(r[0])]+r[1:])) for r in env]},open("public/samples/SAMPLE_environment.json","w"))
