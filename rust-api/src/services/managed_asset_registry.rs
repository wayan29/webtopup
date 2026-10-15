//! SQL managed-asset reference fences and durable filesystem operation journal.
use std::path::{Path, PathBuf};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalImageMetadata { pub format: String, pub width: u32, pub height: u32, pub byte_length: u64 }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryError { Unavailable, NotFound, ReferenceMismatch, ReferenceUnderflow, PathInvalid, AlreadyDeleting, Storage, TransactionAbortFailed, AmbiguousCommit, TransientTransaction }
impl RegistryError {
 pub fn code(self)-> &'static str { match self { Self::NotFound=>"MANAGED_ASSET_NOT_FOUND", Self::PathInvalid=>"MANAGED_ASSET_PATH_INVALID", Self::AlreadyDeleting=>"MANAGED_ASSET_ALREADY_DELETING", Self::ReferenceMismatch=>"MANAGED_ASSET_REFERENCE_MISMATCH", Self::ReferenceUnderflow=>"MANAGED_ASSET_REFERENCE_UNDERFLOW", Self::Storage=>"MANAGED_ASSET_STORAGE_FAILURE", _=>"MANAGED_ASSET_REGISTRY_UNAVAILABLE" } }
 pub fn requires_reconciliation(self)->bool { matches!(self,Self::AmbiguousCommit|Self::TransactionAbortFailed|Self::TransientTransaction) }
}
impl From<sqlx::Error> for RegistryError { fn from(_:sqlx::Error)->Self { Self::Unavailable } }
pub fn managed_asset_deletion_ready(folder:&str)->bool { folder=="covers" }
pub fn canonical_managed_path(path:&str)->Result<(&str,&str),RegistryError> {
 let mut parts=path.strip_prefix("/uploads/").ok_or(RegistryError::PathInvalid)?.split('/');
 let folder=parts.next().ok_or(RegistryError::PathInvalid)?; let name=parts.next().ok_or(RegistryError::PathInvalid)?;
 if parts.next().is_some() || !matches!(folder,"icons"|"covers"|"popups"|"instructions") || name.is_empty() || name=="." || name==".." || !name.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'.'|b'_'|b'-')) { return Err(RegistryError::PathInvalid); }
 Ok((folder,name))
}
pub async fn acquire_reference(tx:&mut Transaction<'_,Postgres>,path:&str,resource:&str)->Result<(),RegistryError> {
 if !path.starts_with("/uploads/") {return Ok(());} canonical_managed_path(path)?;
 let state:String=sqlx::query_scalar("SELECT state FROM managed_assets WHERE path=$1 FOR UPDATE").bind(path).fetch_optional(&mut **tx).await?.ok_or(RegistryError::NotFound)?;
 if state!="available" {return Err(RegistryError::AlreadyDeleting);}
 sqlx::query("INSERT INTO asset_references(path,resource) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(path).bind(resource).execute(&mut **tx).await?;
 sqlx::query("UPDATE managed_assets SET acquisition_fence=acquisition_fence+1 WHERE path=$1").bind(path).execute(&mut **tx).await?; Ok(())
}
pub async fn release_reference(tx:&mut Transaction<'_,Postgres>,path:&str,resource:&str)->Result<(),RegistryError> {
 if !path.starts_with("/uploads/") {return Ok(());} canonical_managed_path(path)?;
 sqlx::query("SELECT path FROM managed_assets WHERE path=$1 FOR UPDATE").bind(path).fetch_optional(&mut **tx).await?.ok_or(RegistryError::NotFound)?;
 let n=sqlx::query("DELETE FROM asset_references WHERE path=$1 AND resource=$2").bind(path).bind(resource).execute(&mut **tx).await?.rows_affected();
 if n!=1 {return Err(RegistryError::ReferenceMismatch);} Ok(())
}
pub async fn prepare_publication(pool:&PgPool,payload:&serde_json::Value)->Result<Uuid,RegistryError> {
 let id=Uuid::new_v4(); sqlx::query("INSERT INTO managed_asset_journal(id,operation,payload) VALUES($1,'publish',$2)").bind(id).bind(payload).execute(pool).await?; Ok(id)
}
fn sync_parent(path:&Path)->Result<(),RegistryError> { std::fs::File::open(path.parent().ok_or(RegistryError::PathInvalid)?).and_then(|f|f.sync_all()).map_err(|_|RegistryError::Storage) }
fn staging_root(upload_root: &Path) -> PathBuf {
 upload_root.parent().map(|parent| parent.join(".webtopup-upload-staging")).unwrap_or_else(|| PathBuf::from(".webtopup-upload-staging"))
}
fn unlink(path:&Path)->Result<(),RegistryError> { match std::fs::remove_file(path) { Ok(())=>sync_parent(path), Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()), Err(_)=>Err(RegistryError::Storage) } }
/// A transaction-scoped advisory lock prevents recovery racing an active publisher. Recovery
/// finishes an entire journal batch or removes its partial publication, never inventing rows.
pub async fn recover_pending(pool:&PgPool,root:&Path)->Result<(),RegistryError> {
 let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM managed_asset_journal WHERE status='pending' ORDER BY created_at").fetch_all(pool).await?;
 for id in ids { finish_operation(pool,root,id).await?; } Ok(())
}
pub async fn finish_operation(pool:&PgPool,root:&Path,id:Uuid)->Result<(),RegistryError> {
 let mut tx=pool.begin().await?;
 let row=sqlx::query("SELECT operation,payload FROM managed_asset_journal WHERE id=$1 AND status='pending' FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
 let Some(row)=row else {return Ok(());};
 let operation:String=row.get("operation"); let payload:serde_json::Value=row.get("payload");
 if operation=="publish" {
  let entries=payload.as_array().ok_or(RegistryError::PathInvalid)?;
  let mut paths=Vec::with_capacity(entries.len());
  for entry in entries { let url=entry["url"].as_str().ok_or(RegistryError::PathInvalid)?; let (folder,name)=canonical_managed_path(url)?; let final_path=root.join(folder).join(name); let temp=staging_root(root).join(format!(".{name}.part")); paths.push((entry,folder,final_path,temp)); }
  let mut failed=false;
  for (_,_,final_path,temp) in &paths { if !final_path.is_file() && (!temp.is_file() || std::fs::rename(temp,final_path).is_err()) { failed=true; break; } sync_parent(final_path)?; sync_parent(temp)?; }
  if failed { for (_,_,final_path,temp) in &paths { unlink(final_path)?; unlink(temp)?; } sqlx::query("UPDATE managed_asset_journal SET status='failed',completed_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?; tx.commit().await.map_err(|_|RegistryError::AmbiguousCommit)?; return Err(RegistryError::Storage); }
  for (entry,folder,_,_) in &paths { sqlx::query("INSERT INTO managed_assets(path,folder,metadata) VALUES($1,$2,$3)").bind(entry["url"].as_str().ok_or(RegistryError::PathInvalid)?).bind(folder).bind(&entry["metadata"]).execute(&mut *tx).await?; }
 } else {
  let path=payload["url"].as_str().ok_or(RegistryError::PathInvalid)?; let (folder,name)=canonical_managed_path(path)?;
  if !managed_asset_deletion_ready(folder) {return Err(RegistryError::PathInvalid);}
  let state:String=sqlx::query_scalar("SELECT state FROM managed_assets WHERE path=$1 FOR UPDATE").bind(path).fetch_one(&mut *tx).await?;
  if state!="deleting" {return Err(RegistryError::AlreadyDeleting);}
  unlink(&root.join(folder).join(name))?;
  sqlx::query("UPDATE managed_assets SET state='deleted' WHERE path=$1").bind(path).execute(&mut *tx).await?;
 }
 sqlx::query("UPDATE managed_asset_journal SET status='complete',completed_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
 tx.commit().await.map_err(|_|RegistryError::AmbiguousCommit)
}
pub enum DeleteDecision { Ready(Uuid), InUse(Vec<super::managed_assets::AssetReferenceSummary>) }
pub async fn prepare_deletion(pool:&PgPool,path:&str)->Result<DeleteDecision,RegistryError> {
 let (folder,_)=canonical_managed_path(path)?; if !managed_asset_deletion_ready(folder) {return Err(RegistryError::Unavailable);}
 let mut tx=pool.begin().await?;
 let state:String=sqlx::query_scalar("SELECT state FROM managed_assets WHERE path=$1 FOR UPDATE").bind(path).fetch_optional(&mut *tx).await?.ok_or(RegistryError::NotFound)?;
 if state!="available" {return Err(RegistryError::AlreadyDeleting);}
 let refs:Vec<String>=sqlx::query_scalar("SELECT resource FROM asset_references WHERE path=$1 ORDER BY resource").bind(path).fetch_all(&mut *tx).await?;
 if !refs.is_empty() {
  let mut summaries:Vec<super::managed_assets::AssetReferenceSummary>=Vec::new();
  for resource in refs { let label=match resource.split(':').next().unwrap_or("") {"sliders"=>"Sliders","articles"=>"Articles","settings"=>"Settings","products"=>"Products","operators"=>"Operators","categories"=>"Categories","producttypes"=>"Product types","flashsales"=>"Flash sales","rewards"=>"Rewards",_=>"Managed assets"}; if let Some(s)=summaries.iter_mut().find(|s|s.resource==label) {s.count+=1;} else {summaries.push(super::managed_assets::AssetReferenceSummary{resource:label,count:1});} }
  tx.rollback().await?; return Ok(DeleteDecision::InUse(summaries));
 }
 let id=Uuid::new_v4(); sqlx::query("UPDATE managed_assets SET state='deleting' WHERE path=$1").bind(path).execute(&mut *tx).await?;
 sqlx::query("INSERT INTO managed_asset_journal(id,operation,payload) VALUES($1,'delete',$2)").bind(id).bind(serde_json::json!({"url":path})).execute(&mut *tx).await?;
 tx.commit().await.map_err(|_|RegistryError::AmbiguousCommit)?; Ok(DeleteDecision::Ready(id))
}
