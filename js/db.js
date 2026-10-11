import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

function savedCreds(){
  try {
    const u = localStorage.getItem("sd-url"), k = localStorage.getItem("sd-key");
    if (u && k) return { url: u, key: k };
  } catch(e){}
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
  return null;
}

export const db = {
  ready: false,
  client: null,

  init(){
    const c = savedCreds();
    if (!c) return false;
    this.client = createClient(c.url, c.key);
    this.ready = true;
    return true;
  },
  saveCreds(url, key){
    try {
      localStorage.setItem("sd-url", url.trim());
      localStorage.setItem("sd-key", key.trim());
    } catch(e){}
  },

  /* ---------- auth ---------- */
  async signUp(email, password, name, role){
    const { data, error } = await this.client.auth.signUp({
      email, password,
      options: { data: { name, role } }
    });
    if (error) throw error;
    return data;
  },
  async signIn(email, password){
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },
  async signOut(){ await this.client.auth.signOut(); },
  async session(){
    const { data } = await this.client.auth.getSession();
    return data.session || null;
  },
  onAuthChange(fn){
    return this.client.auth.onAuthStateChange((_ev, session) => fn(session));
  },
  async myProfile(){
    const { data: { user } } = await this.client.auth.getUser();
    if (!user) return null;
    const { data, error } = await this.client.from("profiles").select("*").eq("id", user.id).single();
    if (error) return { id: user.id, email: user.email, role: (user.user_metadata && user.user_metadata.role) || "coach", name: (user.user_metadata && user.user_metadata.name) || "" };
    return data;
  },

  /* ---------- hitters ---------- */
  async createHitter(name, bats){
    const { data: { user } } = await this.client.auth.getUser();
    const code = "SD-" + Array.from(crypto.getRandomValues(new Uint8Array(3)))
      .map(b => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 32]).join("");
    const { data, error } = await this.client.from("hitters")
      .insert({ coach_id: user.id, name, bats, invite_code: code })
      .select().single();
    if (error) throw error;
    return data;
  },
  async myHitters(){
    const { data, error } = await this.client.from("hitters")
      .select("*, swings(count)").order("name");
    if (error) throw error;
    return data;
  },
  async claimHitter(code){
    const { data, error } = await this.client.rpc("claim_hitter", { p_code: code.trim().toUpperCase() });
    if (error) throw error;
    return data;
  },
  async myHitterRow(){
    const { data, error } = await this.client.from("hitters").select("*").limit(1).single();
    if (error) throw error;
    return data;
  },

  /* ---------- swings ---------- */
  async uploadSwing(hitterId, blob, mime, meta){
    const sid = crypto.randomUUID();
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const path = `swings/${hitterId}/${sid}.${ext}`;
    const { error: upErr } = await this.client.storage.from("swing-videos")
      .upload(path, blob, { contentType: mime, upsert: false });
    if (upErr) throw upErr;
    const { data, error } = await this.client.from("swings").insert({
      hitter_id: hitterId, video_path: path,
      duration_s: meta.durationS || null, clip_source: meta.source || "manual"
    }).select().single();
    if (error) throw error;
    return data;
  },
  async listSwings(hitterId){
    const { data, error } = await this.client.from("swings")
      .select("*, tags(tag, created_at)")
      .eq("hitter_id", hitterId).order("taken_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async getSwing(id){
    const { data, error } = await this.client.from("swings")
      .select("*, tags(tag, created_at), hitters(name)")
      .eq("id", id).single();
    if (error) throw error;
    return data;
  },
  async deleteSwing(swing){
    const { error: sErr } = await this.client.storage.from("swing-videos").remove([swing.video_path]);
    if (sErr) throw sErr;
    const { error } = await this.client.from("swings").delete().eq("id", swing.id);
    if (error) throw error;
  },
  async swingUrl(path){
    const { data, error } = await this.client.storage.from("swing-videos").createSignedUrl(path, 3600);
    if (error) throw error;
    return data.signedUrl;
  },
  async setFavorite(id, fav){
    const { error } = await this.client.from("swings").update({ favorite: fav }).eq("id", id);
    if (error) throw error;
  },
  async setNote(id, note){
    const { error } = await this.client.from("swings").update({ note }).eq("id", id);
    if (error) throw error;
  },

  /* ---------- tags ---------- */
  async addTag(swingId, tag){
    const { error } = await this.client.from("tags").insert({ swing_id: swingId, tag });
    if (error) throw error;
  },
  async removeTag(swingId, tag){
    const { error } = await this.client.from("tags").delete().eq("swing_id", swingId).eq("tag", tag);
    if (error) throw error;
  }
};
