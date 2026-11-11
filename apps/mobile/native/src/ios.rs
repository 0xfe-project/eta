//! A full-screen camera that closes on the first QR code.

use std::cell::{Cell, RefCell};
use std::sync::mpsc::{Receiver, Sender, channel};

use block2::RcBlock;
use dispatch2::{DispatchQueue, GlobalQueueIdentifier, DispatchQoS};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput,
    AVCaptureMetadataOutput, AVCaptureMetadataOutputObjectsDelegate, AVCaptureOutput,
    AVCaptureSession, AVCaptureVideoPreviewLayer, AVLayerVideoGravityResizeAspectFill,
    AVMediaTypeVideo, AVMetadataMachineReadableCodeObject, AVMetadataObject,
    AVMetadataObjectTypeQRCode,
};
use objc2_foundation::{NSArray, NSString, NSURL};
use objc2_ui_kit::{
    UIActivityViewController, UIApplication, UIButton, UIButtonType, UIColor, UIControlEvents, UIControlState,
    UIModalPresentationStyle, UIViewController, UIWindow, UIWindowScene,
};

pub fn available() -> bool {
    unsafe { AVCaptureDevice::defaultDeviceWithMediaType(AVMediaTypeVideo.unwrap()) }.is_some()
}

struct Ivars {
    answer: Cell<Option<Sender<Option<String>>>>,
    session: RefCell<Option<Retained<AVCaptureSession>>>,
    controller: RefCell<Option<Retained<UIViewController>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct Reader;

    unsafe impl NSObjectProtocol for Reader {}

    unsafe impl AVCaptureMetadataOutputObjectsDelegate for Reader {
        #[unsafe(method(captureOutput:didOutputMetadataObjects:fromConnection:))]
        fn did_output(
            &self,
            _output: &AVCaptureOutput,
            objects: &NSArray<AVMetadataObject>,
            _connection: &AVCaptureConnection,
        ) {
            let found = objects.iter().find_map(|object| {
                let code = object.downcast::<AVMetadataMachineReadableCodeObject>().ok()?;
                unsafe { code.stringValue() }.map(|text| text.to_string())
            });
            if found.is_some() {
                self.finish(found);
            }
        }
    }

    impl Reader {
        #[unsafe(method(close:))]
        fn close(&self, _sender: Option<&AnyObject>) {
            self.finish(None);
        }
    }
);

impl Reader {
    fn new(mtm: MainThreadMarker, answer: Sender<Option<String>>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            answer: Cell::new(Some(answer)),
            session: RefCell::new(None),
            controller: RefCell::new(None),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Once: a second code in the same frame finds the answer already taken.
    fn finish(&self, code: Option<String>) {
        let Some(answer) = self.ivars().answer.take() else {
            return;
        };
        let _ = answer.send(code);
        if let Some(session) = self.ivars().session.borrow_mut().take() {
            let session = Shared(session);
            background().exec_async(move || {
                let session = session;
                unsafe { session.0.stopRunning() };
            });
        }
        if let Some(controller) = self.ivars().controller.borrow_mut().take() {
            controller.dismissViewControllerAnimated_completion(true, None);
        }
    }

    fn show(this: &Retained<Self>) {
        let mtm = this.mtm();
        let Some(presenter) = top_controller(mtm) else {
            this.finish(None);
            return;
        };
        let Some(session) = capture_session(this) else {
            this.finish(None);
            return;
        };
        let controller = UIViewController::new(mtm);
        controller.setModalPresentationStyle(UIModalPresentationStyle::FullScreen);
        let view = controller.view().expect("a controller's view");
        view.setBackgroundColor(Some(&UIColor::blackColor()));
        let preview = unsafe { AVCaptureVideoPreviewLayer::layerWithSession(&session) };
        unsafe { preview.setVideoGravity(AVLayerVideoGravityResizeAspectFill.unwrap()) };
        preview.setFrame(view.bounds());
        view.layer().addSublayer(&preview);

        let close = UIButton::buttonWithType(UIButtonType::System, mtm);
        close.setTitle_forState(
            Some(&NSString::from_str("Close")),
            UIControlState::Normal,
        );
        unsafe { close.setTintColor(Some(&UIColor::whiteColor())) };
        let bounds = view.bounds();
        close.setFrame(objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(16.0, 60.0),
            objc2_foundation::NSSize::new(bounds.size.width - 32.0, 44.0),
        ));
        unsafe {
            close.addTarget_action_forControlEvents(
                Some(this.as_ref()),
                sel!(close:),
                UIControlEvents::TouchUpInside,
            );
        }
        view.addSubview(&close);

        *this.ivars().session.borrow_mut() = Some(session.clone());
        *this.ivars().controller.borrow_mut() = Some(controller.clone());
        // The reader lives until the view is gone: `finish` drops what it holds, not itself.
        let keep = this.clone();
        let completion = RcBlock::new(move || {
            let _ = &keep;
        });
        unsafe {
            presenter.presentViewController_animated_completion(&controller, true, Some(&completion))
        };
        let session = Shared(session);
        background().exec_async(move || {
            let session = session;
            unsafe { session.0.startRunning() };
        });
    }
}

/// Started and stopped off the main thread: both block, and Apple's docs say to.
fn background() -> dispatch2::DispatchRetained<DispatchQueue> {
    DispatchQueue::global_queue(GlobalQueueIdentifier::QualityOfService(
        DispatchQoS::UserInitiated,
    ))
}

/// `AVCaptureSession` is documented as usable from a queue of its own; objc2 cannot know that.
struct Shared(Retained<AVCaptureSession>);
unsafe impl Send for Shared {}

fn capture_session(reader: &Retained<Reader>) -> Option<Retained<AVCaptureSession>> {
    let device = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(AVMediaTypeVideo?) }?;
    let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }.ok()?;
    let session = unsafe { AVCaptureSession::new() };
    if !unsafe { session.canAddInput(&input) } {
        return None;
    }
    unsafe { session.addInput(&input) };
    let output = unsafe { AVCaptureMetadataOutput::new() };
    if !unsafe { session.canAddOutput(&output) } {
        return None;
    }
    unsafe { session.addOutput(&output) };
    unsafe {
        output.setMetadataObjectsDelegate_queue(
            Some(ProtocolObject::from_ref(&**reader)),
            Some(DispatchQueue::main()),
        );
        output.setMetadataObjectTypes(Some(&NSArray::from_slice(&[
            AVMetadataObjectTypeQRCode,
        ])));
    }
    Some(session)
}

fn top_controller(mtm: MainThreadMarker) -> Option<Retained<UIViewController>> {
    let app = UIApplication::sharedApplication(mtm);
    let window: Option<Retained<UIWindow>> = app.connectedScenes()
        .iter()
        .find_map(|scene| scene.downcast::<UIWindowScene>().ok())
        .and_then(|scene| scene.keyWindow());
    let mut controller = window?.rootViewController()?;
    while let Some(next) = controller.presentedViewController() {
        controller = next;
    }
    Some(controller)
}

/// Show the share sheet for a file, over whatever is on top.
pub fn share(path: String) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue");
        let Some(presenter) = top_controller(mtm) else {
            return;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        let items = NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(url))]);
        let sheet = unsafe {
            UIActivityViewController::initWithActivityItems_applicationActivities(
                UIActivityViewController::alloc(mtm),
                &items,
                None,
            )
        };
        // On an iPad the sheet is a popover and has to hang from something.
        if let (Some(popover), Some(view)) = (sheet.popoverPresentationController(), presenter.view()) {
            popover.setSourceView(Some(&view));
        }
        presenter.presentViewController_animated_completion(&sheet, true, None);
    });
}

/// Ask for the camera if nobody has yet, then show it. The answer is `None` when refused.
pub fn scan() -> Receiver<Option<String>> {
    let (answer, receiver) = channel();
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue");
        let media = unsafe { AVMediaTypeVideo.unwrap() };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
        if status == AVAuthorizationStatus::Authorized {
            Reader::show(&Reader::new(mtm, answer));
            return;
        }
        if status != AVAuthorizationStatus::NotDetermined {
            let _ = answer.send(None);
            return;
        }
        let answer = std::sync::Mutex::new(Some(answer));
        let granted = RcBlock::new(move |granted: Bool| {
            let answer = answer.lock().unwrap().take();
            DispatchQueue::main().exec_async(move || {
                let Some(answer) = answer else { return };
                if granted.as_bool() {
                    let mtm = MainThreadMarker::new().expect("the main queue");
                    Reader::show(&Reader::new(mtm, answer));
                } else {
                    let _ = answer.send(None);
                }
            });
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &granted) };
    });
    receiver
}
