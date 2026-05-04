/*
 * Elevation and depth overlay diagnostic.
 *
 * Three values are shown for the terrain point under the cursor:
 *
 *   Elevation      — geographic height above the reference ellipsoid (metres),
 *                    derived from getHitCoords + convertCoordsFromNavToPublic.
 *
 *   Ground dist    — true camera-to-surface distance in geographic space
 *                    (metres). Computed by converting the hit point to ECEF
 *                    and taking the vector length in camera space.
 *
 *   Rendered depth — camera-to-surface distance as measured in the rendered
 *                    scene (metres), read directly from the GPU depth buffer
 *                    via getScreenDepth.
 *
 * When vertical exaggeration (VE) is active, Ground dist and Rendered depth
 * diverge. The reason: getHitCoords strips VE from the returned nav coords
 * (via getUnsuperElevatedHeight), so Ground dist is always a geographic
 * distance regardless of VE. getScreenDepth samples the hitmap, which is
 * rendered with VE applied — terrain features are taller in the rendered
 * scene than in reality, so the camera is closer to them. With VE off, the
 * two values are identical. Use the VE button to observe the effect.
 */
(function () {
  var browser = cartolina.browser('map', {
    map: 'https://cdn.tspl.re/store/a-3d-mountain-map/map-config/map/mapConfig.json',
    position: ['obj', -118.302348, 36.560197, 'fix', 3313.32, -133.38, -25.09, 0.00, 33347.92, 45.00],
    controlSearch: false,
    controlCompass: false,
    controlMeasure: false,
    controlZoom: false,
    controlSpace: false,
    controlFallback: false
  });

  if (!browser) { console.error('WebGL not supported'); return; }

  var overlay = document.getElementById('overlay');
  var veBtn = document.getElementById('ve-btn');
  var veSpec = null; // saved VE spec for restore

  veBtn.addEventListener('click', function () {
    var current = browser.getVerticalExaggeration();
    if (current && (current.scaleRamp || current.elevationRamp)) {
      veSpec = current;
      browser.setVerticalExaggeration({});
      veBtn.textContent = 'VE: off';
      veBtn.classList.add('off');
    } else {
      if (veSpec) browser.setVerticalExaggeration(veSpec);
      veBtn.textContent = 'VE: on';
      veBtn.classList.remove('off');
    }
  });

  function updateOverlay(e) {
    if (!browser) return;

    var xy = e.getMouseCoords();
    var nav = browser.getHitCoords(xy[0], xy[1], 'fix');

    // depth from the rendered (VE-exaggerated) surface via depth buffer
    var depthApi = browser.getScreenDepth(xy[0], xy[1], 0);
    var depthApiStr = '—';
    if (depthApi && depthApi[0]) {
      depthApiStr = depthApi[1].toFixed(2) + ' m';
    }

    if (nav) {
      var pub = browser.convertCoordsFromNavToPublic(nav, 'fix');
      var phys = browser.convertCoordsFromNavToPhys(nav, 'fix');
      var camVec = browser.convertCoordsFromPhysToCameraSpace(phys);
      var groundDist = Math.hypot(camVec[0], camVec[1], camVec[2]);

      overlay.innerHTML =
        'Elevation: <b>' + pub[2].toFixed(2) + ' m</b> · ' +
        'Ground dist: <b>' + groundDist.toFixed(2) + ' m</b> · ' +
        'Rendered depth: <b>' + depthApiStr + '</b>';
    } else {
      overlay.innerHTML =
        'Elevation: <b>— m</b> · Ground dist: <b>— m</b> · ' +
        'Rendered depth: <b>' + depthApiStr + '</b>';
    }
  }

  var el = browser.ui.getMapElement();
  el.on('mousemove', updateOverlay);
  el.on('mouseleave', function () {
    overlay.innerHTML =
      'Elevation: <b>— m</b> · Ground dist: <b>— m</b> · ' +
      'Rendered depth: <b>—</b>';
  });
})();
