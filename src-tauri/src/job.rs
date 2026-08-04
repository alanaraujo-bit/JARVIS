//! Contenção de árvore de processos.
//!
//! `TerminateProcess` mata só o shell. Tudo que ele lançou (`npm run dev`,
//! `cargo watch`, um agente de IA) sobrevive segurando porta e pasta, invisível
//! para o usuário que "fechou a aba". Um Job Object com
//! `KILL_ON_JOB_CLOSE` amarra a árvore inteira à sessão.

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, zeroed};
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct Job(HANDLE);

    // O handle é usado por várias threads (leitura, espera, comandos da UI);
    // as chamadas do Win32 sobre ele são seguras para uso concorrente.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(null(), null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self(handle))
            }
        }

        /// Prende um processo (e, por herança, seus filhos) ao job.
        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if proc.is_null() {
                    return false;
                }
                let ok = AssignProcessToJobObject(self.0, proc);
                CloseHandle(proc);
                ok != 0
            }
        }

        /// Derruba a árvore inteira agora.
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // Fechar o último handle dispara KILL_ON_JOB_CLOSE.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Job;

    impl Job {
        pub fn create() -> Option<Self> {
            None
        }
        pub fn assign(&self, _pid: u32) -> bool {
            false
        }
        pub fn terminate(&self) {}
    }
}

pub use imp::Job;
