import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExecutionContext } from "./contracts.js";
import type { FollowupAction, FollowupGap, FollowupPlanDependencies, FollowupPlanRequest, FollowupPlanResult, PlanningMaterial, PlanWindow } from "./followup-plan-contracts.js";
import { followupActionSchema, followupPlanRequestSchema, planningMaterialSchema } from "./followup-plan-schema.js";
import { preparePlanningMaterials } from "./followup-plan-materials.js";
import { redactSensitiveText } from "./video-analysis.js";

function missing(target: PlanWindow, covered: PlanWindow[]): PlanWindow[] {
  let cursor = target.start_seconds;
  const result: PlanWindow[] = [];
  for (const w of [...covered].sort((a,b) => a.start_seconds-b.start_seconds)) {
    const start = Math.max(target.start_seconds,w.start_seconds), end = Math.min(target.end_seconds,w.end_seconds);
    if (end <= cursor || end <= start) continue;
    if (start > cursor) result.push({start_seconds:cursor,end_seconds:start});
    cursor = Math.max(cursor,end);
  }
  if (cursor < target.end_seconds) result.push({start_seconds:cursor,end_seconds:target.end_seconds});
  return result;
}
async function bounded<T>(operation:()=>Promise<T>, context:ExecutionContext):Promise<T> {
  context.signal.throwIfAborted();
  let listener:(()=>void)|undefined;
  const abort = new Promise<never>((_,reject)=>{listener=()=>reject(context.signal.reason??new DOMException("Cancelled.","AbortError"));context.signal.addEventListener("abort",listener,{once:true});});
  try {return await Promise.race([Promise.resolve().then(operation),abort]);}
  finally {if(listener)context.signal.removeEventListener("abort",listener);}
}
function error(code:string,message:string):never {throw Object.assign(new Error(message),{code});}

/** Union overlapping requested gaps before choosing bounded chunks. Disjoint selections stay disjoint. */
function coalesce(gaps:FollowupGap[]):FollowupGap[] {
  const groups=new Map<string,FollowupGap[]>();
  for(const [i,g] of gaps.entries()){
    const key=g.source_key&&(g.window||g.pages)?JSON.stringify([g.source_key,g.window?"video":"note",g.state]):`single:${i}`;
    const rows=groups.get(key)??[];rows.push(g);groups.set(key,rows);
  }
  const output:FollowupGap[]=[];
  for(const rows of groups.values()){
    if(!rows[0].window&&!rows[0].pages){output.push(...rows);continue;}
    const start=(g:FollowupGap)=>g.window?.start_seconds??g.pages!.start_page;
    const end=(g:FollowupGap)=>g.window?.end_seconds??g.pages!.end_page+1;
    const cuts=[...new Set(rows.flatMap(g=>[start(g),end(g)]))].sort((a,b)=>a-b);
    let previous:FollowupGap|undefined;
    for(let i=0;i<cuts.length-1;i++){
      const a=cuts[i],b=cuts[i+1],active=rows.filter(g=>start(g)<=a&&end(g)>=b);
      if(!active.length){previous=undefined;continue;}
      const l=active.some(g=>g.channel==="language"||g.channel==="multimodal"),v=active.some(g=>g.channel==="vision"||g.channel==="multimodal");
      const channel=l&&v?"multimodal":l?"language":v?"vision":null;
      const kind=active[0].state==="blocked"?"access_blocked":active.every(g=>g.kind==="scope_extension")?"scope_extension":v&&active.some(g=>g.kind==="visual_question_changed")?"visual_question_changed":"coverage_gap";
      const material_ids=[...new Set(active.flatMap(g=>g.material_ids))],evidence_ids=[...new Set(active.flatMap(g=>g.evidence_ids))];
      if(previous&&previous.channel===channel&&previous.kind===kind&&end(previous)===a){
        if(previous.window)previous.window.end_seconds=b;else previous.pages!.end_page=b-1;
        previous.material_ids=[...new Set([...previous.material_ids,...material_ids])];previous.evidence_ids=[...new Set([...previous.evidence_ids,...evidence_ids])];
      }else{
        previous={...active[0],kind,channel,material_ids,evidence_ids,window:active[0].window?{start_seconds:a,end_seconds:b}:null,pages:active[0].pages?{start_page:a,end_page:b-1}:null,reason:[...new Set(active.map(g=>g.reason))].join(" ")};output.push(previous);
      }
    }
  }
  return output.map((g,i)=>({...g,id:`gap:${i+1}`}));
}

/** Produce inspectable suggestions; never invoke the suggested tools or a model. */
export async function planResearchFollowup(request:FollowupPlanRequest, overrides:Partial<FollowupPlanDependencies>={}, signal?:AbortSignal):Promise<FollowupPlanResult> {
  const at=performance.now();
  const result:FollowupPlanResult={schema_version:"1.0",status:"unavailable",question:typeof request?.question==="string"?request.question.trim().slice(0,2000):"",materials:[],gaps:[],next_actions:[],stop_reason:"invalid_request",budget:{max_actions:3,max_sources:2,max_rounds:2,round:1,deferred_gaps:0},warnings:["This is a stateless plan, not execution or proof that the question is answered. The host supplies round/history and enforces cumulative execution budgets.","Only actual retained coverage and explicit evidence targets produce reading actions. Source status is preserved; a single-source claim or not-addressed position is not automatically a gap.","Chronological/page-order windows are bounded acquisition suggestions, not verified locations of a relevant claim or formula."],errors:[],processing:{duration_ms:0,model_calls:0,executed_actions:0}};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    let raw:string;
    try {raw=JSON.stringify(request);}catch{error("INVALID_REQUEST","Supply a serializable planning request.");}
    if(Buffer.byteLength(raw!??"")>2*1024*1024)error("PLAN_BUDGET_EXCEEDED","Planning input exceeds 2 MiB; select smaller saved results.");
    const parsed=followupPlanRequestSchema.safeParse(request);
    if(!parsed.success)error("INVALID_REQUEST","Supply one to three research materials, a question and valid planning limits.");
    const input=parsed.data;
    result.question=input.question;
    result.budget={max_actions:input.maxActions,max_sources:input.maxSources,max_rounds:input.maxRounds,round:input.round,deferred_gaps:0};
    if(input.round>input.maxRounds){result.status="stopped";result.stop_reason="budget_exhausted";return result;}
    const controller=new AbortController();timer=setTimeout(()=>controller.abort(new DOMException("Planning deadline exceeded.","TimeoutError")),input.planningTimeoutSeconds*1000);
    const context:ExecutionContext={signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,deadlineMs:Date.now()+input.planningTimeoutSeconds*1000};
    const prepared=await bounded(()=>(overrides.prepare??preparePlanningMaterials)(input.materials as FollowupPlanRequest["materials"],input.question,context),context);
    result.materials=prepared.map(m=>planningMaterialSchema.parse(m));
    const groups=new Map<string,PlanningMaterial[]>();
    const gapMap=new Map<string,FollowupGap>();
    const add=(m:PlanningMaterial|undefined,kind:FollowupGap["kind"],channel:FollowupGap["channel"],window:FollowupGap["window"],pages:FollowupGap["pages"],reason:string,state:FollowupGap["state"]="actionable")=>{
      const key=JSON.stringify([m?.source_key??m?.id??"search",kind,channel,window,pages]);
      const old=gapMap.get(key);
      if(old){if(m&&!old.material_ids.includes(m.id))old.material_ids.push(m.id);if(m)old.evidence_ids=[...new Set([...old.evidence_ids,...m.evidence_ids])];return;}
      const gap:FollowupGap={id:`gap:${result.gaps.length+1}`,material_ids:m?[m.id]:[],source_key:m?.source_key??null,kind,channel,window,pages,evidence_ids:m?[...m.evidence_ids]:[],reason,state};
      gapMap.set(key,gap);result.gaps.push(gap);
    };
    for(const m of result.materials){
      if(!m.eligible||!m.source_key||!m.url||!m.family){add(m,"invalid_material",null,null,null,"The supplied identity or metadata cannot safely define a reading action; select or repair the material.","needs_selection");continue;}
      const group=groups.get(m.source_key)??[];group.push(m);groups.set(m.source_key,group);
    }
    for(const group of groups.values()){
      context.signal.throwIfAborted();
      const languageWindows=group.flatMap(m=>m.language_windows),visualWindows=group.flatMap(m=>m.visual_windows);
      const languagePages=new Set(group.flatMap(m=>m.language_pages)),visualPages=new Set(group.flatMap(m=>m.visual_pages));
      for(const m of group){
        const required=input.evidenceRequirement==="original"?m.original_mode:input.evidenceRequirement;
        if(!required){add(m,"invalid_material",null,null,null,"Select the required evidence channels before reading.","needs_selection");continue;}
        const needLanguage=required!=="vision",needVisual=required!=="language";
        if(m.family==="video"&&m.requested_window&&m.duration_seconds){
          const target=input.coverageTarget==="source"?{start_seconds:0,end_seconds:m.duration_seconds}:m.requested_window;
          const language=needLanguage?missing(target,languageWindows):[],visual=needVisual?missing(target,visualWindows):[];
          const cuts=[...new Set([target.start_seconds,target.end_seconds,...[m.requested_window.start_seconds,m.requested_window.end_seconds].filter(x=>x>target.start_seconds&&x<target.end_seconds),...language.flatMap(w=>[w.start_seconds,w.end_seconds]),...visual.flatMap(w=>[w.start_seconds,w.end_seconds])])].sort((a,b)=>a-b);
          let previous:{kind:FollowupGap["kind"];channel:NonNullable<FollowupGap["channel"]>;window:PlanWindow}|undefined;
          const segments:NonNullable<typeof previous>[]=[];
          for(let i=0;i<cuts.length-1;i++){
            const start=cuts[i],end=cuts[i+1],l=language.some(w=>w.start_seconds<=start&&w.end_seconds>=end),v=visual.some(w=>w.start_seconds<=start&&w.end_seconds>=end);
            if(!l&&!v){previous=undefined;continue;}
            const channel=l&&v?"multimodal":l?"language":"vision";
            const extension=end<=m.requested_window.start_seconds||start>=m.requested_window.end_seconds;
            const kind=extension?"scope_extension":v&&m.visual_question_changed?"visual_question_changed":"coverage_gap";
            if(previous&&previous.kind===kind&&previous.channel===channel&&previous.window.end_seconds===start)previous.window.end_seconds=end;
            else{previous={kind,channel,window:{start_seconds:start,end_seconds:end}};segments.push(previous);}
          }
          for(const s of segments)add(m,s.kind,s.channel,s.window,null,s.kind==="scope_extension"?"Explicit whole-source target extends the previous selected range; this is additional reading, not failure of the original request.":s.kind==="visual_question_changed"?"The old visual observations answer a different question. Re-inspect actual frames for this question.":"The required channel has no retained evidence in this source interval.");
        }else if(m.family==="note"&&m.requested_pages&&m.image_count!==null){
          const target=input.coverageTarget==="source"?{start_page:1,end_page:m.image_count}:m.requested_pages;
          let current:{kind:FollowupGap["kind"];channel:NonNullable<FollowupGap["channel"]>;pages:{start_page:number;end_page:number}}|undefined;
          const segments:NonNullable<typeof current>[]=[];
          for(let page=target.start_page;page<=target.end_page;page++){
            const l=needLanguage&&!languagePages.has(page),v=needVisual&&!visualPages.has(page);
            if(!l&&!v){current=undefined;continue;}
            const channel=l&&v?"multimodal":l?"language":"vision";
            const extension=page<m.requested_pages.start_page||page>m.requested_pages.end_page;
            const kind=extension?"scope_extension":v&&m.visual_question_changed?"visual_question_changed":"coverage_gap";
            if(current&&current.channel===channel&&current.kind===kind&&current.pages.end_page===page-1)current.pages.end_page=page;
            else{current={kind,channel,pages:{start_page:page,end_page:page}};segments.push(current);}
          }
          for(const s of segments)add(m,s.kind,s.channel,null,s.pages,s.kind==="scope_extension"?"Explicit whole-note target includes pages outside the old selection.":s.kind==="visual_question_changed"?"Inspect these original image pages for the changed question; old visual observations were excluded.":"The required image-text or visual channel is missing for these original pages.");
        }
      }
      if(group.some(m=>m.access!=="not_checked"))for(const gap of result.gaps.filter(g=>g.source_key===group[0].source_key&&g.state==="actionable")){
        gap.kind="access_blocked";gap.state="blocked";gap.reason="This actual coverage gap is subject to a reported source-access restriction. Resolve access or select another source; no retry is planned.";
      }
    }
    if(input.searchQueries){
      const blocked=!!input.discovery&&(["blocked","auth_required","rate_limited"].includes(input.discovery.stop_reason)||input.discovery.errors.some(e=>["SEARCH_BLOCKED","SEARCH_AUTH_REQUIRED","SEARCH_RATE_LIMITED"].includes(e.code)));
      add(undefined,"requested_search",null,null,null,blocked?"Earlier discovery reported an access restriction; no additional search is planned.":"The host explicitly requested these additional search queries; this is not inferred from a single-source comparison.",blocked?"blocked":"actionable");
    }
    result.gaps=coalesce(result.gaps);
    const usedSources=new Set<string>(),actions=new Map<string,FollowupAction>();
    for(const gap of result.gaps){
      context.signal.throwIfAborted();
      if(gap.state!=="actionable")continue;
      const material=result.materials.find(m=>gap.material_ids.includes(m.id));
      let tool:FollowupAction["tool"],args:Record<string,unknown>;
      const resumeHasChannels=material?.original_mode==="multimodal"||material?.original_mode===gap.channel;
      const resumable=material?.can_resume&&material.session_id&&resumeHasChannels&&input.coverageTarget==="requested"&&input.evidenceRequirement==="original"&&(material.resume_window_seconds??input.videoWindowSeconds)<=input.videoWindowSeconds;
      if(gap.kind==="requested_search"){tool="discover_bilibili_videos";args={question:input.question,queries:input.searchQueries!,max_candidates:10,timeout_seconds:Math.min(120,input.actionTimeoutSeconds)};}
      else if(resumable){tool="resume_long_video_research";args={session_id:material.session_id,timeout_seconds:input.actionTimeoutSeconds,window_timeout_seconds:Math.min(180,input.actionTimeoutSeconds),max_download_mb:64};}
      else if(material?.url&&gap.window){tool="analyze_video_url";args={url:material.url,question:input.question,mode:gap.channel!,include_comments:false,start_seconds:gap.window.start_seconds,end_seconds:Math.min(gap.window.end_seconds,gap.window.start_seconds+input.videoWindowSeconds),timeout_seconds:input.actionTimeoutSeconds,...(material.language?{language:material.language}:{}),...(material.source_quality?{source_quality:material.source_quality}:{})};}
      else if(material?.url&&gap.pages){tool="analyze_xiaohongshu_note";args={url:material.url,question:input.question,mode:gap.channel==="language"?"text":gap.channel==="vision"?"vision":"combined",start_page:gap.pages.start_page,end_page:Math.min(gap.pages.end_page,gap.pages.start_page+input.notePagesPerAction-1),timeout_seconds:input.actionTimeoutSeconds,...(material.language?{language:material.language}:{})};}
      else{gap.state="needs_selection";continue;}
      const {timeout_seconds:_timeout,window_timeout_seconds:_window,max_download_mb:_bytes,...semantic}=args;
      const key=createHash("sha256").update(JSON.stringify({question:input.question,tool,source:gap.source_key,arguments:semantic})).digest("hex");
      if(input.attemptedActionKeys.includes(key)){gap.state="previously_attempted";continue;}
      const old=actions.get(key);
      if(old){old.gap_ids.push(gap.id);old.material_ids=[...new Set([...old.material_ids,...gap.material_ids])];continue;}
      if(actions.size>=input.maxActions||(gap.source_key&&!usedSources.has(gap.source_key)&&usedSources.size>=input.maxSources)){gap.state="deferred";continue;}
      const action:FollowupAction={key,gap_ids:[gap.id],material_ids:[...gap.material_ids],source_key:gap.source_key,tool,arguments:args,reason:gap.reason,preconditions:["The host selects and executes this suggestion. Research tools must revalidate source identity and access before acquiring evidence.","Provide a fresh original access URL if the platform requires it. Execution may incur provider/download cost; no fee or success estimate is asserted."]};
      followupActionSchema.parse(action);actions.set(key,action);if(gap.source_key)usedSources.add(gap.source_key);
    }
    result.next_actions=[...actions.values()];result.budget.deferred_gaps=result.gaps.filter(g=>g.state==="deferred").length;
    result.status=result.next_actions.length?"planned":"stopped";
    result.stop_reason=result.next_actions.length?"actions_available":result.gaps.some(g=>g.state==="deferred")?"budget_exhausted":result.gaps.some(g=>g.state==="previously_attempted")?"history_exhausted":result.gaps.some(g=>g.state==="blocked"||g.state==="needs_selection")?"blocked":"no_actionable_gaps";
  }catch(e){const value=e as {name?:string;code?:string;message?:string};result.status="unavailable";result.stop_reason=value.name==="TimeoutError"?"timeout":value.name==="AbortError"||signal?.aborted?"cancelled":"invalid_request";result.errors.push({code:value.name==="TimeoutError"?"TIMEOUT":value.name==="AbortError"||signal?.aborted?"CANCELLED":value.code??"PLAN_FAILED",message:redactSensitiveText(value.message??"Planning failed.")});result.next_actions=[];}
  finally{if(timer)clearTimeout(timer);result.processing.duration_ms=Math.round(performance.now()-at);}
  return result;
}
