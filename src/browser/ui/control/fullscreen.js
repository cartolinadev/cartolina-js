
import Dom_ from '../../utility/dom';

//get rid of compiler mess
var dom = Dom_;


var UIControlFullscreen = function(ui, visible, visibleLock) {
    this.ui = ui;
    this.control = this.ui.addControl('fullscreen',
      '<img id="vts-fullscreen" class="vts-fullscreen" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAwUlEQVRo3u2YwRWDIBBEIc+SLMKmckpTFkFPePKQQ57DsitR/z/D6KgMDikBAMCTycKYxai9Bul8MYkic+NFS7BOs4FUa/1IrzTn9xk6O6+rrwEMjGayTlS/UXWeujbcDKgpEZRObgYOc1oYt7CIMXCFFLKmTrS+aqAEP8iSAGBYI1s776FLv7eReaWHWd/cyLz3Bas+vxIYGNXIhBTxOhcKNdCaHvPfGPjVYb3OhVjEGLhrI/Pewc9uZDQvAABwZQMKFi+DmFdLbgAAAABJRU5ErkJggg==">'
      , visible, visibleLock);
      
    var img = this.control.getElement('vts-fullscreen');
    img.on('click', this.onClick.bind(this));
    img.on('dblclick', this.onDoNothing.bind(this));
    
    this.enabled = false;
};


UIControlFullscreen.prototype.onDoNothing = function(event) {
    dom.preventDefault(event);    
    dom.stopPropagation(event);    
};


UIControlFullscreen.prototype.requestFullscreen = function(element) {
    if(element.requestFullscreen) {
        element.requestFullscreen();
    } else if(element.mozRequestFullScreen) {
        element.mozRequestFullScreen();
    } else if(element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
    } else if(element.msRequestFullscreen) {
        element.msRequestFullscreen();
    }
};


UIControlFullscreen.prototype.exitFullscreen = function() {
    if(document.exitFullscreen) {
        document.exitFullscreen();
    } else if(document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
    } else if(document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
    }
};


UIControlFullscreen.prototype.fullscreenEnabled = function() {
    return (document.fullscreenEnabled || document.mozFullScreenEnabled || document.webkitFullscreenEnabled);
};


/**
 * Return the element currently displayed in native fullscreen, across
 * vendor prefixes, or a falsy value when none is.
 */
UIControlFullscreen.prototype.fullscreenElement = function() {
    return (document.fullscreenElement || document.webkitFullscreenElement
        || document.mozFullScreenElement || document.msFullscreenElement);
};


/**
 * Toggle a CSS overlay that stretches the map wrapper across the
 * viewport. Used as a fallback where the native Fullscreen API is
 * unavailable. The renderer picks up the new wrapper size on the next
 * frame, the same way it reacts to a native fullscreen resize.
 */
UIControlFullscreen.prototype.toggleFakeFullscreen = function() {

    var element = this.ui.element;
    var on = !element.classList.contains('vts-fullscreen-fake');

    element.classList.toggle('vts-fullscreen-fake', on);
    this.enabled = on;
};


/**
 * Handle a click on the fullscreen button, toggling fullscreen on the
 * map wrapper. Uses the native Fullscreen API where available, and a CSS
 * overlay where it is not.
 */
UIControlFullscreen.prototype.onClick = function() {

    //Safari on iPhone implements the Fullscreen API for <video> only, so
    //the map wrapper has no requestFullscreen method and the native path
    //silently fails. Fall back to a CSS overlay there. iPadOS Safari and
    //desktop browsers report fullscreen support and take the native path.
    if (!this.fullscreenEnabled()) {

        this.toggleFakeFullscreen();
        return;
    }

    if (this.fullscreenElement()) {

        this.exitFullscreen();
        this.enabled = false;

    } else {

        this.requestFullscreen(this.ui.element);
        this.enabled = true;
    }
};

export default UIControlFullscreen;
