/*
 * Elevation and depth overlay diagnostic.
 *
 * Three values are shown for the terrain point under the cursor:
 *
 *   Elevation      — geographic height above the reference ellipsoid
 *                    (metres), from getHitCoords +
 *                    convertCoordsFromNavToPublic.
 *
 *   Ground dist    — true camera-to-surface distance in geographic
 *                    space (metres). Computed by converting the hit
 *                    point to ECEF and taking the vector length in
 *                    camera space.
 *
 *   Rendered depth — camera-to-surface distance as measured in the
 *                    rendered scene (metres), read from the GPU depth
 *                    buffer via getScreenDepth.
 *
 * When vertical exaggeration (VE) is active, Ground dist and Rendered
 * depth diverge. getHitCoords strips VE from the returned nav coords,
 * so Ground dist is always a geographic distance regardless of VE.
 * getScreenDepth samples the hitmap, which is rendered with VE applied
 * — terrain features are taller in the rendered scene than in reality,
 * so the camera is closer to them. With VE off the two values are
 * identical. Use the VE button to observe the effect.
 */
(function () {

    var viewer = cartolina.map({
        container: 'map',
        style: './style.json',
        position: [
            'obj', -118.302348, 36.560197,
            'fix', 3313.32, -133.38, -25.09, 0.00, 33347.92, 45.00,
        ],
    });

    var el      = document.getElementById('map');
    var overlay = document.getElementById('overlay');
    var veBtn   = document.getElementById('ve-btn');
    var veSpec  = null;

    veBtn.addEventListener('click', function () {

        var current = viewer.getVerticalExaggeration();

        if (current && (current.scaleRamp || current.elevationRamp)) {
            veSpec = current;
            viewer.setVerticalExaggeration({});
            veBtn.textContent = 'VE: off';
            veBtn.classList.add('off');
        } else {
            if (veSpec) viewer.setVerticalExaggeration(veSpec);
            veBtn.textContent = 'VE: on';
            veBtn.classList.remove('off');
        }
    });

    function updateOverlay(e) {

        var x   = e.clientX;
        var y   = e.clientY;
        var nav = viewer.getHitCoords(x, y, 'fix');

        var depthApi    = viewer.getScreenDepth(x, y, 0);
        var depthApiStr = '—';

        if (depthApi && depthApi[0]) {
            depthApiStr = depthApi[1].toFixed(2) + ' m';
        }

        if (nav) {
            var pub    = viewer.convertCoordsFromNavToPublic(nav, 'fix');
            var phys   = viewer.convertCoordsFromNavToPhys(nav, 'fix');
            var camVec = viewer.convertCoordsFromPhysToCameraSpace(phys);
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

    el.addEventListener('mousemove', updateOverlay);

    el.addEventListener('mouseleave', function () {
        overlay.innerHTML =
            'Elevation: <b>— m</b> · Ground dist: <b>— m</b> · ' +
            'Rendered depth: <b>—</b>';
    });

}());
