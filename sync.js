import {putCachedProject, saveProject} from './dataStore.js';

export class ProjectSync {
  constructor({userId,projectId,getState,revision=0,dirty=false,conflicted=false,onStatus,onConflict,onRevision,save=saveProject,writeCache=putCachedProject}) {
    Object.assign(this,{userId,projectId,getState,revision,dirty,onStatus,onConflict,onRevision});
    this.saveFn=save;this.writeCache=writeCache;
    this.generation=0;this.timer=null;this.inFlight=false;this.stopped=false;this.conflicted=conflicted;this.retryDelay=2500;
    this.cacheQueue=Promise.resolve();
    this.onOnline=()=>{if(this.dirty)this.flush();};
    window.addEventListener('online',this.onOnline);
    if (conflicted) this.onStatus('conflict');
    else if (dirty) {this.onStatus(navigator.onLine?'pending':'offline');this.queue(1000);}
    else this.onStatus('synced');
  }
  cache(dirty=this.dirty) {
    const state=this.getState();
    const value={project:structuredClone(state.project),name:state.name,description:state.description,
      revision:this.revision,dirty,updatedAt:new Date().toISOString()};
    this.cacheQueue=this.cacheQueue.catch(()=>{}).then(()=>this.writeCache(this.userId,this.projectId,value));
    this.cacheQueue.catch(()=>this.onStatus('cache-error'));
    return this.cacheQueue;
  }
  markDirty() {
    if(this.stopped)return;
    this.dirty=true;this.generation++;
    this.onStatus(this.conflicted?'conflict':navigator.onLine?'pending':'offline');
    this.cache(true);
    if(!this.conflicted)this.queue(800);
  }
  queue(delay=800) {
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>this.flush(),delay);
  }
  async flush() {
    if(this.stopped||!this.dirty||this.inFlight||this.conflicted)return;
    if(!navigator.onLine){this.onStatus('offline');return;}
    this.inFlight=true;this.onStatus('syncing');
    const generation=this.generation;
    try {
      await this.cacheQueue;
      const state=this.getState();
      const row=await this.saveFn(this.userId,this.projectId,state.project,state.name,state.description,this.revision);
      this.revision=row.revision;this.onRevision?.(row.revision,row.updated_at);
      this.retryDelay=2500;
      this.dirty=this.generation!==generation;
      await this.cache(this.dirty);
      this.onStatus(this.dirty?'pending':'synced');
    } catch(error) {
      this.dirty=true;
      await this.cache(true).catch(()=>{});
      if(error.code==='conflict'||error.status===409){this.conflicted=true;this.onStatus('conflict');this.onConflict?.(error);}
      else {
        this.onStatus(error.code==='network'||!navigator.onLine?'offline':'failed',error);
        this.retryDelay=Math.min(this.retryDelay*2,30000);
        this.queue(this.retryDelay);
      }
    } finally {
      this.inFlight=false;
      if(this.dirty && !this.stopped && navigator.onLine && this.generation!==generation) this.queue(800);
    }
  }
  stop() {this.stopped=true;clearTimeout(this.timer);window.removeEventListener('online',this.onOnline);}
}
