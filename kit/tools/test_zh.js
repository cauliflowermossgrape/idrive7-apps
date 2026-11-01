'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os');
const kit=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../runtime');
const i18n=require(path.join(kit,'i18n')),{t,getLanguage,setLanguage}=i18n;
const locale=JSON.parse(fs.readFileSync(path.join(kit,'locale.json'),'utf8'));
const available=locale.languages||[locale.language||'en'];
const {HmiText,slotId}=require(path.join(kit,'hmi-text'));
const {Canvas}=require(path.join(kit,'canvas'));
const {Recorder,atlasId}=require(path.join(kit,'record'));
const {CREDIT,drawCredit}=require(path.join(kit,'credits'));
const fonts=require(path.join(kit,'fonts'));
const {statusInfo,NRC}=require(path.join(kit,'diag'));
const {fitText}=require(path.join(kit,'text-layout'));
const initial=getLanguage(),chinese=initial==='zh-CN',russian=initial==='ru';
const expected={en:'Settings','zh-CN':'设置',ru:'Настройки'};
async function main(){
 assert.strictEqual(t('Settings'),expected[initial]||'Settings');
 assert.strictEqual(t('rpm'),'rpm');assert.strictEqual(t('config.battery'),'config.battery');
 assert.strictEqual(typeof setLanguage,'function');
 const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mgu-language-')));
 try{
  fs.copyFileSync(path.join(kit,'i18n.js'),path.join(tmp,'i18n.js'));fs.mkdirSync(path.join(tmp,'locales'));
  const catalogs={'zh-CN':{Settings:'设置'},ru:{Settings:'Настройки'},'de-test':{Settings:'Einstellungen'}};
  for(const [language,catalog] of Object.entries(catalogs))fs.writeFileSync(path.join(tmp,'locales',language+'.json'),JSON.stringify(catalog));
  fs.writeFileSync(path.join(tmp,'locale.json'),JSON.stringify({language:'en',languages:['en',...Object.keys(catalogs)],strings:{}}));
  const generic=require(path.join(tmp,'i18n.js'));
  for(const language of ['en','zh-CN','ru','de-test']){
   generic.setLanguage(language);assert.strictEqual(generic.t('Settings'),generic.getLanguage()==='en'?'Settings':catalogs[language].Settings);
  }
 }finally{for(const file of fs.readdirSync(path.join(tmp,'locales')))fs.unlinkSync(path.join(tmp,'locales',file));fs.rmdirSync(path.join(tmp,'locales'));fs.unlinkSync(path.join(tmp,'i18n.js'));fs.unlinkSync(path.join(tmp,'locale.json'));fs.rmdirSync(tmp)}
 const updates=[],writes=[],component={getStringBundle:()=>({setStrings:async x=>updates.push(x)}),setValue:async(...x)=>writes.push(x)};
 const hmi=new HmiText();await hmi.set(component,'BTN',0,'Text','Scan now');
 if(chinese||russian){assert.strictEqual(updates[0][slotId(0)],russian?'Сканировать':'立即扫描');assert.strictEqual(writes[0][3],'StringId')}
 else assert.deepStrictEqual(writes[0],[0,'Text','Scan now','Text']);
 await hmi.set(component,'CODE',0,'Text','D1C604');assert.deepStrictEqual(writes[1],[0,'Text','D1C604','Text']);
 for(const language of available){
  if(language==='en')continue;
  const sample=language==='ru'?'Привет':'中文',f=fonts.get('bold',32,sample),catalog=JSON.parse(fs.readFileSync(path.join(kit,'locales',language+'.json'),'utf8'));
  assert.notStrictEqual(atlasId(f,'supplemental'),atlasId(Object.assign({},f,{cacheKey:f.cacheKey+'-changed'}),'supplemental'),'font updates must not reuse an old GPU texture');
  const credit=language==='zh-CN'?CREDIT:'';
  for(const ch of credit+Object.values(catalog).join(''))assert(f.glyphs[ch.codePointAt(0)],'missing '+language+' glyph '+ch);
 }
 const cv=new Canvas(800,120),r=new Recorder(800,120),opts={font:'bold'};
 if(available.includes('zh-CN')){
  setLanguage('zh-CN');
  assert.strictEqual(t(t('eDrive')),t('eDrive'),'localized app titles must not be translated twice');
  assert.strictEqual(t('RANGE AT THIS RATE'),'按当前能耗估算续航');
  assert.strictEqual(t('Engine Config'),'发动机配置');
  assert.strictEqual(t('Transmission Config'),'变速箱配置');
  assert.strictEqual(t('Max Cooling ON'),'最大冷却 开启');
  assert.strictEqual(t('64 cells'),'64 个单元格','map cells are not battery cells');
  assert.strictEqual(t('up'),'升挡','translate stored shift groups only at display time');
  for(const bits of [0x01,0x80,0x04,0x08,0])assert.notStrictEqual(t(statusInfo(bits).label),statusInfo(bits).label,'untranslated DTC status');
  for(const label of Object.values(NRC))assert.notStrictEqual(t(label),label,'untranslated diagnostic rejection '+label);
  const fitted=fitText(cv,'ZGM: Ethernet: Communication ended unexpectedly',22,190);
  assert(!fitted.includes('Ethernet')&&fitted.includes('以太网'),'translate the full diagnostic sentence before truncation');
  assert(cv.textWidth(fitted,22)<=190,'localized truncated text must fit');
  const G=require(path.join(kit,'gauges')),theme=require(path.join(kit,'themes')).theme('m_tricolour');
  const labels=[],mock={w:1600,fillRect:()=>{},gradientRect:()=>{},textWidth:()=>50,text:(s)=>labels.push(s)};
  G.frame(mock,theme,['History','Faults'],0,[]);assert(labels.includes('历史')&&labels.includes('故障'));
 }
 if(available.includes('ru')){
  setLanguage('ru');assert.strictEqual(t('Settings'),'Настройки');assert.strictEqual(t('Max Cooling ON'),'МАКСИМАЛЬНОЕ ОХЛАЖДЕНИЕ ВКЛ.');
  assert.strictEqual(t('64 cells'),'64 ячейки');assert.strictEqual(t('up'),'вверх');
  for(const bits of [0x01,0x80,0x04,0x08,0])assert.notStrictEqual(t(statusInfo(bits).label),statusInfo(bits).label,'untranslated Russian DTC status');
  for(const label of Object.values(NRC))assert.notStrictEqual(t(label),label,'untranslated Russian diagnostic rejection '+label);
 }
 setLanguage(initial);
 assert.strictEqual(cv.text('Oil',10,50,32,'#ffffff',opts),r.text('Oil',10,50,32,'#ffffff',opts));
 assert.strictEqual(cv.textWidth('Oil',32,opts),r.textWidth('Oil',32,opts));
 const credit=new Canvas(600,40);drawCredit(credit,580,25);let alpha=0;
 for(let i=3;i<credit.d.length;i+=4)alpha=Math.max(alpha,credit.d[i]);
 assert(chinese?alpha>0&&alpha<=64:alpha===0,'credit visibility follows the active language');
 let height=0;for(const name of fs.readdirSync(path.join(kit,'fonts')).filter(x=>x.endsWith('.json'))){
  const file=JSON.parse(fs.readFileSync(path.join(kit,'fonts',name),'utf8'));for(const s of file.sizes){assert(s.atlasW<=1024&&s.atlasH<=4096);height+=s.atlasH+1}
 }assert(height<8192,'GPU atlas budget');
 console.log('PASS: '+available.join(',')+' package, language switching, native strings, glyphs, renderer metrics and credit visibility');
}
main().catch(e=>{console.error(e);process.exit(1)});
