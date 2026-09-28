// Backup.gs — weekly snapshot of the whole spreadsheet into an "app00046 backups" Drive folder.
// Sheets version history covers accidental edits; this covers the file itself being deleted
// or corrupted. Run setupBackupTrigger() once by hand.
// Scope: only drive.file (files this script itself created) — the copy is made through
// SpreadsheetApp, so the script never needs access to the rest of your Drive. Add
// "https://www.googleapis.com/auth/drive.file" to oauthScopes in appsscript.json.

var BACKUP_KEEP_ = 12; // weekly copies kept (~3 months); older ones go to Drive trash (30-day undo)

function backupFolder_() {
  var id = getSetting_("BACKUP_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* folder deleted — recreate below */ }
  }
  // drive.file can't see the spreadsheet's own folder, so the backup folder lives in My Drive root
  var folder = DriveApp.createFolder("app00046 backups");
  setSetting_("BACKUP_FOLDER_ID", folder.getId());
  log_("INFO", "backup", "created backup folder " + folder.getId());
  return folder;
}

function backupSheet() {
  var folder = backupFolder_();
  var stamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HHmm");
  // SpreadsheetApp.copy() needs only the spreadsheets scope; the new file is ours, so drive.file can move it
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID).copy("app00046-flights-db backup " + stamp);
  var copy = DriveApp.getFileById(ss.getId());
  copy.moveTo(folder);

  // retention: newest BACKUP_KEEP_ copies stay, the rest are trashed (not hard-deleted)
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  var trashed = 0;
  files.slice(BACKUP_KEEP_).forEach(function (f) { f.setTrashed(true); trashed++; });

  log_("INFO", "backup", "snapshot " + copy.getName() + (trashed ? "; trashed " + trashed + " old" : ""));
  Logger.log("backup created: %s", copy.getUrl());
  return copy.getId();
}

// Run once by hand: weekly backup every Monday ~03:00 (script timezone), plus one right now.
function setupBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "backupSheet") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("backupSheet").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  log_("INFO", "triggers", "weekly backup trigger installed");
  backupSheet();
}
