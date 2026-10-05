//! Saves the current page as a PDF without a print dialog, using the webview's own engine:
//! WebView2 `PrintToPdf` on Windows, WebKitGTK print-to-file on Linux. macOS reports
//! "unsupported" and the app falls back to the system print dialog.

use std::path::PathBuf;

use serde::Deserialize;
use tokio::sync::oneshot;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOptions {
    /// "a4" or "letter".
    pub paper: String,
    pub landscape: bool,
    pub margin_mm: f64,
}

impl PdfOptions {
    /// Portrait paper size in millimetres.
    fn paper_mm(&self) -> (f64, f64) {
        match self.paper.as_str() {
            "letter" => (215.9, 279.4),
            _ => (210.0, 297.0),
        }
    }
}

type Done = oneshot::Sender<Result<(), String>>;

/// Starts writing `out`; `done` receives the result when the engine finishes.
pub fn print_to_file(webview: &tauri::Webview, out: PathBuf, options: &PdfOptions, done: Done) -> Result<(), String> {
    imp::print_to_file(webview, out, options, done)
}

#[cfg(target_os = "linux")]
mod imp {
    use std::cell::RefCell;
    use std::rc::Rc;

    use webkit2gtk::PrintOperationExt;

    use super::*;

    pub fn print_to_file(webview: &tauri::Webview, out: PathBuf, options: &PdfOptions, done: Done) -> Result<(), String> {
        let (width, height) = options.paper_mm();
        let landscape = options.landscape;
        let margin = options.margin_mm;
        webview
            .with_webview(move |platform| {
                let uri = match gtk::glib::filename_to_uri(&out, None) {
                    Ok(uri) => uri,
                    Err(e) => {
                        let _ = done.send(Err(e.to_string()));
                        return;
                    }
                };
                let settings = gtk::PrintSettings::new();
                settings.set_printer("Print to File");
                settings.set("output-file-format", Some("pdf"));
                settings.set("output-uri", Some(uri.as_str()));

                let setup = gtk::PageSetup::new();
                setup.set_paper_size(&gtk::PaperSize::new_custom("quill", "Quill", width, height, gtk::Unit::Mm));
                setup.set_orientation(if landscape { gtk::PageOrientation::Landscape } else { gtk::PageOrientation::Portrait });
                setup.set_top_margin(margin, gtk::Unit::Mm);
                setup.set_bottom_margin(margin, gtk::Unit::Mm);
                setup.set_left_margin(margin, gtk::Unit::Mm);
                setup.set_right_margin(margin, gtk::Unit::Mm);

                let op = webkit2gtk::PrintOperation::new(&platform.inner());
                op.set_print_settings(&settings);
                op.set_page_setup(&setup);

                // "failed" is followed by "finished"; the first one to fire reports.
                let done = Rc::new(RefCell::new(Some(done)));
                let on_fail = done.clone();
                op.connect_failed(move |_, err| {
                    if let Some(tx) = on_fail.borrow_mut().take() {
                        let _ = tx.send(Err(err.to_string()));
                    }
                });
                op.connect_finished(move |_| {
                    if let Some(tx) = done.borrow_mut().take() {
                        let _ = tx.send(Ok(()));
                    }
                });
                op.print();
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::{Arc, Mutex};

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    use super::*;

    const MM_PER_INCH: f64 = 25.4;

    pub fn print_to_file(webview: &tauri::Webview, out: PathBuf, options: &PdfOptions, done: Done) -> Result<(), String> {
        let (width, height) = options.paper_mm();
        let landscape = options.landscape;
        let margin = options.margin_mm / MM_PER_INCH;
        webview
            .with_webview(move |platform| {
                let done = Arc::new(Mutex::new(Some(done)));
                let report = {
                    let done = done.clone();
                    move |result: Result<(), String>| {
                        if let Some(tx) = done.lock().unwrap().take() {
                            let _ = tx.send(result);
                        }
                    }
                };
                let on_complete = report.clone();
                let started = unsafe {
                    (|| -> windows::core::Result<()> {
                        let core: ICoreWebView2_7 = platform.controller().CoreWebView2()?.cast()?;
                        let env: ICoreWebView2Environment6 = platform.environment().cast()?;
                        let settings = env.CreatePrintSettings()?;
                        settings.SetOrientation(if landscape {
                            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                        } else {
                            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                        })?;
                        settings.SetPageWidth(width / MM_PER_INCH)?;
                        settings.SetPageHeight(height / MM_PER_INCH)?;
                        settings.SetMarginTop(margin)?;
                        settings.SetMarginBottom(margin)?;
                        settings.SetMarginLeft(margin)?;
                        settings.SetMarginRight(margin)?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, ok| {
                            on_complete(match (status, ok) {
                                (Ok(()), true) => Ok(()),
                                (Ok(()), false) => Err("WebView2 could not write the PDF".into()),
                                (Err(e), _) => Err(e.to_string()),
                            });
                            Ok(())
                        }));
                        core.PrintToPdf(&HSTRING::from(out.as_os_str()), &settings, &handler)
                    })()
                };
                if let Err(e) = started {
                    report(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod imp {
    use super::*;

    pub fn print_to_file(_: &tauri::Webview, _: PathBuf, _: &PdfOptions, _: Done) -> Result<(), String> {
        Err("unsupported".into())
    }
}
