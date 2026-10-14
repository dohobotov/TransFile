//! Ties adb client processes to the lifetime of the app.
//!
//! Tauri ends the process without running destructors, so `kill_on_drop` never fires on exit: every
//! `adb track-devices` (and any running adb command) used to survive the app as an orphan, piling up across
//! launches and locking `bin/adb.exe` (rebuilds failed with "file is in use").
//!
//! Children are assigned to a Windows Job Object with KILL_ON_JOB_CLOSE: when the app exits — normally or
//! not — the OS closes the job handle and kills them. SILENT_BREAKAWAY_OK keeps processes *they* start out
//! of the job: if an adb client happens to launch the adb server, the server must outlive the app, otherwise
//! every app exit would drop all device connections (and a MuMu emulator then needs ~2 min to answer again).

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };

    struct Job(HANDLE);
    // The handle is only used for AssignProcessToJobObject, which is thread-safe
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            // The handle is intentionally never closed: the OS closes it when the app exits
            if ok == 0 { None } else { Some(Job(handle)) }
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn bind(child: &tokio::process::Child) {
        if let (Some(job), Some(process)) = (job(), child.raw_handle()) {
            unsafe {
                AssignProcessToJobObject(job, process as HANDLE);
            }
        }
    }
}

/// Makes `child` die together with the app (no-op outside Windows).
pub fn bind_to_app_lifetime(child: &tokio::process::Child) {
    #[cfg(windows)]
    imp::bind(child);
    #[cfg(not(windows))]
    let _ = child;
}
