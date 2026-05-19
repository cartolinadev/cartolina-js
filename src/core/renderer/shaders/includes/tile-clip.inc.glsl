#ifndef TILE_CLIP_INC_GLSL
#define TILE_CLIP_INC_GLSL

uniform float uClip[4];

void applyTileClip(vec2 clipCoord, float clipMargin) {

    bool covered;
    float tmin = 0.5 - clipMargin;
    float tmax = 0.5 + clipMargin;

    if (clipCoord.y > 0.5) {

        if (clipCoord.x > 0.5) {
            covered = (clipCoord.x < tmax && uClip[2] != 0.0)
                || (clipCoord.y < tmax && uClip[1] != 0.0);
            if (uClip[3] == 0.0 && !covered) discard;
        } else {
            covered = (clipCoord.x > tmin && uClip[3] != 0.0)
                || (clipCoord.y < tmax && uClip[0] != 0.0);
            if (uClip[2] == 0.0 && !covered) discard;
        }

    } else {

        if (clipCoord.x > 0.5) {
            covered = (clipCoord.x < tmax && uClip[0] != 0.0)
                || (clipCoord.y > tmin && uClip[3] != 0.0);
            if (uClip[1] == 0.0 && !covered) discard;
        } else {
            covered = (clipCoord.x > tmin && uClip[1] != 0.0)
                || (clipCoord.y > tmin && uClip[2] != 0.0);
            if (uClip[0] == 0.0 && !covered) discard;
        }
    }
}

#endif
