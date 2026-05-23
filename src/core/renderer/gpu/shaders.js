
var GpuShaders = {};

GpuShaders.bboxVertexShader =
    'attribute vec3 aPosition;\n'+
    'uniform mat4 uMVP;\n'+
    'void main(){ \n'+
        'gl_Position = uMVP * vec4(aPosition, 1.0);\n'+
    '}';


GpuShaders.bbox2VertexShader =
    'attribute vec3 aPosition;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform float uPoints[8*3];\n'+
    'void main(){ \n'+
        'int index = int(aPosition.z) * 3; \n'+
        'gl_Position = uMVP * vec4(uPoints[index], uPoints[index+1], uPoints[index+2], 1.0);\n'+
    '}';


GpuShaders.bboxFragmentShader = 'precision mediump float;\n'+
    'void main() {\n'+
        'gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0);\n'+
    '}';


GpuShaders.lineVertexShader = //line
    '#ifndef dataPoints2\n'+
        'uniform mat4 uMVP;\n'+
    '#else\n'+
        'uniform mat4 uMV, uProj;\n'+
    '#endif\n'+

    '#ifdef pixelLine\n'+
        '#ifdef dataPoints2\n'+
            'attribute vec3 aPosition;\n'+
        '#else\n'+
            'attribute vec4 aPosition;\n'+
            'attribute vec4 aNormal;\n'+
        '#endif\n'+

        '#ifdef dataPoints\n'+
            'uniform vec3 uScale;\n'+
            'uniform vec3 uPoints[32];\n'+
        '#else\n'+
            'uniform vec2 uScale;\n'+
        '#endif\n'+

        '#ifdef dataPoints2\n'+

        'vec4 getClippedPixelLinePoint(vec3 p1, vec3 p2, vec3 params) {\n'+
            'vec2 pp1, pp2, n;\n'+
            'vec4 wp0 = (uMV * vec4(p1.xyz, 1.0)), pp0, pp3;\n'+
            'float near = gl_DepthRange.near + 0.1;\n'+
            //'float near = gl_DepthRange.near + 0.1 + 30000.0;\n'+
            'if (params.y < 0.0) {\n'+
                //'return vec4(8.0, 0.0, 0.0, 1.0);\n'+
                'if (wp0.z > -near) return vec4(8.0, 0.0, 0.0, 1.0);\n'+
                'pp0 = uProj * wp0;\n'+
                'if (params.y == -1.0) return pp0;\n'+
                'return pp0 + vec4((vec3(-sin(params.z)*uScale.x*uScale.z*pp0.w, cos(params.z)*uScale.y*uScale.z*pp0.w, 0.0)), 0.0);\n'+
            '} else {\n'+
                'vec3 p2 = uPoints[int(params.y)];\n'+
                'vec4 wp3 = (uMV * vec4(p2.xyz, 1.0));\n'+
                'if (wp0.z > -near) {\n'+
                    'vec3 dir = (wp3.xyz - wp0.xyz);\n'+
                    'float l = length(dir);\n'+
                    'dir = normalize(dir);\n'+
                    'float denominator = -dir.z;\n'+
                    'if (abs(denominator) < 0.0000001) return vec4(8.0, 0.0, 0.0, 1.0);\n'+
                    'float t = (near + wp0.z) / denominator;\n'+
                    'if (t < 0.0 || t > l) return vec4(8.0, 0.0, 0.0, 1.0);\n'+
                    'wp0.xyz = wp0.xyz + (dir * t);\n'+
                '}\n'+
                'pp0 = uProj * wp0;\n'+
                'pp3 = uProj * wp3;\n'+
                'pp1 = pp0.xy / pp0.w;\n'+
                'pp2 = pp3.xy / pp3.w;\n'+
                //'pp1 = pp0.xy;\n'+
                //'pp2 = pp3.xy;\n'+
                'n = normalize(pp2 - pp1);\n'+
                'return pp0 + vec4((vec3(-n.y*uScale.x*params.z*uScale.z*pp0.w, n.x*uScale.y*params.z*uScale.z*pp0.w, 0.0)), 0.0);\n'+
            '}\n'+
        '}\n'+

        '#endif\n'+

    '#else\n'+

        '#ifdef lineLabel2\n'+

            'attribute vec2 aPosition;\n'+
            'uniform vec4 uData[DSIZE];\n'+
            'uniform float uFile;\n'+
            'varying vec2 vTexCoord;\n'+

        '#else\n'+

            '#ifdef lineLabel\n'+
                'attribute vec4 aPosition;\n'+
                'attribute vec4 aTexCoord;\n'+
                'uniform vec4 uVec;\n'+
                'uniform float uFile;\n'+
                'varying vec2 vTexCoord;\n'+
            '#else\n'+
                'attribute vec3 aPosition;\n'+
            '#endif\n'+

            '#ifdef dynamicWidth\n'+
                'attribute vec4 aNormal;\n'+
                'uniform vec4 uParams;\n'+
            '#endif\n'+

        '#endif\n'+

    '#endif\n'+

    '#ifdef applySE\n'+
        'uniform mat4 uParamsSE;\n'+
    '#endif\n'+

    '#ifdef withElements\n'+
        'attribute float aElement;\n'+
        'varying float vElement;\n'+
    '#endif\n'+


    'void main() {\n'+

        '#ifdef withElements\n'+
            'vElement = aElement;\n'+
        '#endif\n'+

        '#ifdef dataPoints\n'+
            'vec3 p1 = uPoints[int(aPosition.x)];\n'+
        '#else \n'+
            '#ifndef lineLabel2\n'+
                'vec3 p1 = aPosition.xyz;\n'+
            '#endif\n'+
        '#endif\n'+

        '#ifdef pixelLine\n'+
            '#ifndef dataPoints\n'+
                'vec3 p2 = aNormal.xyz;\n'+
            '#endif\n'+
        '#endif\n'+

        '#ifdef applySE\n'+
            'vec3 geoPos2 = p1.xyz*vec3(uParamsSE[0][3],uParamsSE[1][0],uParamsSE[1][1]);\n'+
            'vec3 geoPos = geoPos2+vec3(uParamsSE[0][0],uParamsSE[0][1],uParamsSE[0][2]);\n'+
            'geoPos.z *= uParamsSE[3][3];\n'+
            'float ll = length(geoPos);\n'+
            'vec3 v = geoPos * (1.0/(ll+0.0001));\n'+
            'float h = ll - uParamsSE[3][2];\n'+
            'float h2 = clamp(h, uParamsSE[2][1], uParamsSE[2][3]);\n'+
            'float h3 = h;\n'+
            'h *= (uParamsSE[2][2] + ((h2 - uParamsSE[2][1]) * uParamsSE[3][0]) * uParamsSE[3][1]);\n'+
            'geoPos2.xyz += v * (h - h3);\n'+

            '#ifdef pixelLine\n'+

                'vec4 pp0 = uMVP * vec4(geoPos2, 1.0);\n'+

                'if (aNormal.w == 0.0) {\n'+
                    'gl_Position = pp0 + vec4((vec3(aNormal.x*uScale.x*pp0.w, aNormal.y*uScale.y*pp0.w, 0.0)), 0.0);\n'+
                '} else {\n'+
                    'geoPos2 = p2.xyz*vec3(uParamsSE[0][3],uParamsSE[1][0],uParamsSE[1][1]);\n'+
                    'geoPos = geoPos2+vec3(uParamsSE[0][0],uParamsSE[0][1],uParamsSE[0][2]);\n'+
                    'geoPos.z *= uParamsSE[3][3];\n'+
                    'll = length(geoPos);\n'+
                    'v = geoPos * (1.0/(ll+0.0001));\n'+
                    'h = ll - uParamsSE[3][2];\n'+
                    'h2 = clamp(h, uParamsSE[2][1], uParamsSE[2][3]);\n'+
                    'h3 = h;\n'+
                    'h *= (uParamsSE[2][2] + ((h2 - uParamsSE[2][1]) * uParamsSE[3][0]) * uParamsSE[3][1]);\n'+
                    'geoPos2.xyz += v * (h - h3);\n'+

                    'vec4 pp3 = uMVP * vec4(geoPos2, 1.0);\n'+
                    'vec2 pp1 = pp0.xy / pp0.w;\n'+
                    'vec2 pp2 = pp3.xy / pp3.w;\n'+
                    'vec2 n = normalize(pp2 - pp1);\n'+
                    'gl_Position = pp0 + vec4((vec3(-n.y*uScale.x*aNormal.w*pp0.w, n.x*uScale.y*aNormal.w*pp0.w, 0.0)), 0.0);\n'+
                '}\n'+

            '#else\n'+

                '#ifdef lineLabel\n'+

                    'vTexCoord = aTexCoord.xy;\n'+
                    'if (dot(uVec.xyz, vec3(aTexCoord.z, aTexCoord.w, aPosition.w)) < 0.0) {\n'+
                        'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
                    '}else{\n'+
                        'float file = floor(aTexCoord.y/4.0);\n'+
                        'vTexCoord.y = mod(aTexCoord.y,4.0);\n'+
                        'if (file != floor(uFile)) {\n'+
                            'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
                        '}else{\n'+
                            'gl_Position = uMVP * vec4(geoPos2, 1.0);\n'+
                        '}\n'+
                    '}\n'+

                '#else\n'+

                    'gl_Position = uMVP * vec4(geoPos2, 1.0);\n'+

                '#endif\n'+

            '#endif\n'+

        '#else\n'+

            '#ifdef pixelLine\n'+

                '#ifdef dataPoints2\n'+

                    'vec3 p2 = uPoints[int(aPosition.y)];\n'+
                    'gl_Position = getClippedPixelLinePoint(p1.xyz, p2.xyz, aPosition.xyz);\n'+

                '#else\n'+

                    'vec4 pp0 = (uMVP * vec4(p1.xyz, 1.0));\n'+

                    '#ifdef dataPoints\n'+

                        'if (aPosition.y < 0.0) {\n'+
                            'if (aPosition.y == -1.0) {\n'+
                                'gl_Position = pp0;\n'+
                            '} else {\n'+
                                'gl_Position = pp0 + vec4((vec3(-sin(aPosition.z)*uScale.x*uScale.z, cos(aPosition.z)*uScale.y*uScale.z, 0.0)), 0.0);\n'+
                            '}\n'+
                        '} else {\n'+
                            'vec3 p2 = uPoints[int(aPosition.y)];\n'+
                            'vec4 pp3 = (uMVP * vec4(p2.xyz, 1.0));\n'+
                            'vec2 pp1 = pp0.xy / pp0.w;\n'+
                            'vec2 pp2 = pp3.xy / pp3.w;\n'+
                            'vec2 n = normalize(pp2 - pp1);\n'+
                            'gl_Position = pp0 + vec4((vec3(-n.y*uScale.x*aPosition.z*uScale.z, n.x*uScale.y*aPosition.z*uScale.z, 0.0)), 0.0);\n'+
                        '}\n'+

                    '#else\n'+

                        'if (aNormal.w == 0.0) {\n'+
                            'gl_Position = pp0 + vec4((vec3(aNormal.x*uScale.x*pp0.w, aNormal.y*uScale.y*pp0.w, 0.0)), 0.0);\n'+
                        '} else {\n'+
                            'vec4 pp3 = (uMVP * vec4(p2.xyz, 1.0));\n'+
                            'vec2 pp1 = pp0.xy / pp0.w;\n'+
                            'vec2 pp2 = pp3.xy / pp3.w;\n'+
                            'vec2 n = normalize(pp2 - pp1);\n'+
                            'gl_Position = pp0 + vec4((vec3(-n.y*uScale.x*aNormal.w*pp0.w, n.x*uScale.y*aNormal.w*pp0.w, 0.0)), 0.0);\n'+
                        '}\n'+

                    '#endif\n'+

                '#endif\n'+

            '#else\n'+

                '#ifdef lineLabel2\n'+

                    'int index = int(aPosition.x) * 3;\n'+
                    'vec4 data = uData[index];\n'+
                    'vec4 data2 = uData[index+1];\n'+
                    'vec4 data3 = uData[index+2];\n'+

                    'vec3 pos = vec3(data[0],data[1],data[2]);\n'+
                    'vec4 q = vec4(data[3],data2[0],data2[1],data2[2]);\n'+
                    'vec2 factor = vec2(data2[3],data3[0]);\n'+
                    'vec2 uv = vec2(data3[1],data3[2]);\n'+
                    'float duv = data3[3];\n'+
//                    'vec3 up = vec3(1.0,0.0,0.0);\n'+
  //                  'vec3 right = vec3(0.0,1.0,0.0);\n'+

                    //get up, right vectors from quaternion
                    'float x=q[0], y=q[1], z=q[2], w=q[3];\n'+
                    'float x2=x+x, y2=y+y, z2=z+z, xx=x*x2, yx=y*x2, yy=y*y2;\n'+
                    'float zx=z*x2, zy=z*y2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;\n'+

                    'vec3 right = vec3(1.0-yy-zz, yx-wz, zx+wy) * factor.x;\n'+
                    'vec3 up = vec3(yx+wz, 1.0-xx-zz, zy-wx) * (-factor.y);\n'+

                    /*
                      out[0] = 1 - yy - zz;
                      out[3] = yx - wz;
                      out[6] = zx + wy;
                      out[1] = yx + wz;
                      out[4] = 1 - xx - zz;
                      out[7] = zy - wx;
                      out[2] = zx - wy;
                      out[5] = zy + wx;
                      out[8] = 1 - xx - yy;
                    */

                    'float file = floor(uv.y/4.0);\n'+
                    'uv.y = (uv.y-file*4.0);\n'+

                    'int corner = int(aPosition.y);\n'+
                    'if (corner==1){ pos+=right; uv.x+=floor(duv)*(1.0/1024.0);  }\n'+
                    'if (corner==2){ pos+=right; pos+=up; uv.x+=floor(duv)*(1.0/1024.0); uv.y+=fract(duv); }\n'+
                    'if (corner==3){ pos+=up; uv.y+=fract(duv); }\n'+

                    'vTexCoord = uv;\n'+

                    'if (file != floor(uFile)) {\n'+
                        'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
                    '}else{\n'+
                        'gl_Position = uMVP * vec4(pos.xyz, 1.0);\n'+
                    '}\n'+

                '#else\n'+

                    '#ifdef lineLabel\n'+

                        'vTexCoord = aTexCoord.xy;\n'+
                        'if (dot(uVec.xyz, vec3(aTexCoord.z, aTexCoord.w, aPosition.w)) < 0.0) {\n'+
                            'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
                        '}else{\n'+
                            'float file = floor(aTexCoord.y/4.0);\n'+
                            'vTexCoord.y = mod(aTexCoord.y,4.0);\n'+
                            'if (file != floor(uFile)) {\n'+
                                'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
                            '}else{\n'+
                                'gl_Position = uMVP * vec4(aPosition.xyz, 1.0);\n'+
                            '}\n'+
                        '}\n'+

                    '#else\n'+

                        '#ifdef dynamicWidth\n'+
                            'gl_Position = uMVP * vec4(aPosition.xyz + aNormal.xyz*(abs(aNormal.w)*uParams[3]), 1.0);\n'+
                        '#else\n'+
                            'gl_Position = uMVP * vec4(aPosition, 1.0);\n'+
                        '#endif\n'+

                    '#endif\n'+

                '#endif\n'+

            '#endif\n'+

        '#endif\n'+

    '}';


GpuShaders.lineFragmentShader = 'precision mediump float;\n'+ //line

    'uniform vec4 uColor;\n'+

    '#ifdef withElements\n'+
        'varying float vElement;\n'+
    '#endif\n'+

    'void main() {\n'+

        '#ifdef withElements\n'+
            'gl_FragColor.xyz = fract(vec3(1.0/255.0, 1.0/65025.0, 1.0/16581375.0) * vElement) + (-0.5/255.0);\n'+
            'gl_FragColor.w = 1.0;\n'+
        '#else\n'+
            'gl_FragColor = uColor;\n'+
        '#endif\n'+

    '}';

GpuShaders.tlineVertexShader = // textured line
    'attribute vec4 aPosition;\n'+
    'attribute vec4 aNormal;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform vec2 uScale;\n'+
    'uniform vec4 uParams;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main(){ \n'+
        'vec4 p=vec4(aPosition.xyz, 1.0);\n'+
        'p.xyz+=aNormal.xyz*(abs(aNormal.w)*uParams[3]);\n'+
        'if (aNormal.w < 0.0){\n'+
            'vTexCoord=vec2(abs(aPosition.w)*uParams[0], (uParams[1]+uParams[2])*0.5);\n'+
        '} else {\n'+
            'vTexCoord=vec2(abs(aPosition.w)*uParams[0], aPosition.w < 0.0 ? uParams[1] : uParams[2]);\n'+
        '}\n'+

        'gl_Position = uMVP * p;\n'+
    '}';


GpuShaders.tplineVertexShader = // textured pixel line
    'attribute vec4 aPosition;\n'+
    'attribute vec4 aNormal;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform vec2 uScale;\n'+
    'uniform vec4 uParams;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main(){ \n'+
        'vec4 pp0 = (uMVP * vec4(aPosition.xyz, 1.0));\n'+
        'vTexCoord=vec2(abs(aPosition.w)*uParams[0], aPosition.w < 0.0 ? uParams[1] : uParams[2]);\n'+
        'if (aNormal.w == 0.0) {\n'+
            'gl_Position = pp0 + vec4((vec3(aNormal.x*uParams[3]*uScale.x*pp0.w, aNormal.y*uParams[3]*uScale.y*pp0.w, 0.0)), 0.0);\n'+
        '} else {\n'+
            'vec2 pp1 = pp0.xy / pp0.w;\n'+
            'vec4 pp3 = (uMVP * vec4(aNormal.xyz, 1.0));\n'+
            'vec2 pp2 = pp3.xy / pp3.w;\n'+
            'vec2 n = normalize(pp2 - pp1);\n'+
            'gl_Position = pp0 + vec4((vec3(-n.y*uParams[3]*uScale.x*aNormal.w*pp0.w, n.x*uParams[3]*uScale.y*aNormal.w*pp0.w, 0.0)), 0.0);\n'+
        '}\n'+
    '}';

GpuShaders.tlineFragmentShader = 'precision mediump float;\n'+ // textured line
    'uniform sampler2D uSampler;\n'+
    'uniform vec4 uColor;\n'+
    'uniform vec4 uColor2;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main() {\n'+
        'vec4 c=texture2D(uSampler, vTexCoord)*uColor;\n'+
        'gl_FragColor = c;\n'+
    '}';


GpuShaders.tblineFragmentShader = 'precision mediump float;\n'+  // textured line with background color
    'uniform sampler2D uSampler;\n'+
    'uniform vec4 uColor;\n'+
    'uniform vec4 uColor2;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main() {\n'+
        'vec4 c1=texture2D(uSampler, vTexCoord)*uColor;\n'+
        'vec4 c2=uColor2,c=c1;\n'+
        'c.xyz*=c.w; c2.xyz*=c2.w;\n'+
        'c=mix(c,c2,1.0-c.w);\n'+
        'c.xyz/=(c.w+0.00001);\n'+
        'c.w=max(c1.w,c2.w);\n'+
        'gl_FragColor = c;\n'+
    '}';


GpuShaders.polygonVertexShader =
    'attribute vec3 aPosition;\n'+
    'attribute vec3 aNormal;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform mat4 uRot;\n'+
    'uniform vec4 uColor;\n'+
    'varying vec4 vColor;\n'+
    'void main(){ \n'+
        'float l = dot((uRot*vec4(aNormal,1.0)).xyz, vec3(0.0,0.0,1.0)) * 0.5;\n'+
        'vec3 c = uColor.xyz;\n'+
        'c = (l > 0.0) ? mix(c,vec3(1.0,1.0,1.0),l) : mix(vec3(0.0,0.0,0.0),c,1.0+l);\n'+
        'vColor = vec4(c, uColor.w);\n'+
        'gl_Position = uMVP * vec4(aPosition, 1.0);\n'+
    '}';


GpuShaders.polygonFragmentShader = 'precision mediump float;\n'+
    'varying vec4 vColor;\n'+
    'void main() {\n'+
        'gl_FragColor = vColor;\n'+
    '}';


GpuShaders.iconVertexShader =
    'attribute vec4 aPosition;\n'+
    'attribute vec4 aTexCoord;\n'+
    'attribute vec3 aOrigin;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform vec4 uScale;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main(){ \n'+
        'vTexCoord = aTexCoord.xy * uScale[2];\n'+
        'vec4 pos = (uMVP * vec4(aOrigin, 1.0));\n'+
        'gl_Position = pos + vec4(aPosition.x*uScale.x*pos.w, (aPosition.y+uScale.w)*uScale.y*pos.w, 0.0, 0.0);\n'+
    '}';

GpuShaders.icon2VertexShader =
    'attribute vec4 aPosition;\n'+
    'attribute vec4 aTexCoord;\n'+
    'attribute vec3 aOrigin;\n'+
    'uniform mat4 uMVP;\n'+
    'uniform vec4 uScale;\n'+
    'uniform float uFile;\n'+
    'varying vec2 vTexCoord;\n'+
    //'float round(float x) { return floor(x + 0.5); }\n'+
    'void main(){ \n'+
        'vTexCoord = aTexCoord.xy * uScale[2];\n'+
        'float file = floor(aTexCoord.y/4.0);\n'+
        'vTexCoord.y = mod(aTexCoord.y,4.0);\n'+
        'if (file != floor(uFile)) {\n'+
            'gl_Position = uMVP * vec4(8.0, 0.0, 0.0, 1.0);\n'+
        '}else{\n'+
            'vec4 pos = (uMVP * vec4(aOrigin, 1.0));\n'+
            //'pos.x = (floor((pos.x/pos.w)*800.0+0.5)/800.0)*pos.w;\n'+
            //'pos.y = (floor((pos.y/pos.w)*410.0+0.5)/410.0)*pos.w;\n'+
            'gl_Position = pos + vec4(aPosition.x*uScale.x*pos.w, (aPosition.y+uScale.w)*uScale.y*pos.w, 0.0, 0.0);\n'+
        '}'+
    '}';


GpuShaders.icon3VertexShader =
    'attribute vec2 aPosition;\n'+
    'uniform mat4 uProjectionMatrix;\n'+
    'uniform vec4 uScale;\n'+
    'uniform vec3 uOrigin;\n'+
    'uniform vec4 uData[DSIZE];\n'+
    'uniform float uFile;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main(){ \n'+
        'int index = int(aPosition.x);\n'+
        'vec4 data = uData[index];\n'+
        'vec4 data2 = uData[index+1];\n'+
        'vec4 v;\n'+
        'int corner = int(aPosition.y);\n'+
        'if (corner==0) v = vec4(data.x, data.y, data2.x, data2.y);\n'+
        'if (corner==1) v = vec4(data.z, data.y, data2.z, data2.y);\n'+
        'if (corner==2) v = vec4(data.z, data.w, data2.z, data2.w);\n'+
        'if (corner==3) v = vec4(data.x, data.w, data2.x, data2.w);\n'+
        'vTexCoord = vec2(v.z, v.w);\n'+
        'float file = floor(v.w/4.0);\n'+
        //'vTexCoord.y = mod(v.w,4.0);\n'+
        'vTexCoord.y = (v.w-file*4.0);\n'+

        'if (file != floor(uFile)) {\n'+
            'gl_Position = uProjectionMatrix * vec4(2.0, 0.0, 0.0, 2.0);\n'+
        '}else{\n'+
            'vec4 pos = (uProjectionMatrix * vec4(uOrigin.xyz, 1.0));\n'+
            'gl_Position = pos + vec4(v.x*uScale.x*pos.w, v.y*uScale.y*pos.w, 0.0, 0.0);\n'+
        '}'+
    '}';

GpuShaders.textFragmentShader = 'precision mediump float;\n'+
    'uniform sampler2D uSampler;\n'+
    'uniform vec4 uColor;\n'+
    'varying vec2 vTexCoord;\n'+
    'void main() {\n'+
        'vec4 c=texture2D(uSampler, vTexCoord);\n'+
        'if(c.w < 0.01){ discard; }\n'+
        'gl_FragColor = c*uColor;\n'+
    '}';

GpuShaders.text2FragmentShader = 'precision mediump float;\n'+
    'uniform sampler2D uSampler;\n'+
    'uniform vec4 uColor;\n'+
    'uniform vec2 uParams;\n'+
    'varying vec2 vTexCoord;\n'+
    'float round(float x) { return floor(x + 0.5); }\n'+

    'void main() {\n'+
        'vec2 uv=(vTexCoord);\n'+
        'uv.y=fract(uv.y);\n'+
        'vec4 c=texture2D(uSampler, uv);\n'+

        'float r = 0.0;\n'+
        'int i=int(floor(vTexCoord.y));\n'+

        'if (i == 0) r=c.x;else\n'+
        'if (i == 1) r=c.y;else\n'+
        'if (i == 2) r=c.z;else\n'+
        'if (i == 3) r=c.w;\n'+

        'float u_buffer = uParams[0];\n'+
        'float u_gamma = uParams[1];\n'+
        'float alpha = uColor.a * smoothstep(u_buffer - u_gamma, u_buffer + u_gamma, r);\n'+

        //'gl_FragColor = vec4(0.0,0.0,1.0,1.0);\n'+

        'if(alpha < 0.01){ discard; }\n'+
        'gl_FragColor = vec4(uColor.rgb, alpha);\n'+
    '}';

GpuShaders.quadPoint =
    'vec3 quadPoint(int i1, int i2, int i3, float t, float t2) {\n'+
        'float p1x = uPoints[i1], p1y = uPoints[i1+1], p1z = uPoints[i1+2];\n'+
        'float p3x = uPoints[i3], p3y = uPoints[i3+1], p3z = uPoints[i3+2];\n'+
        'float p2x = 2.0*uPoints[i2]-p1x*0.5-p3x*0.5;\n'+
        'float p2y = 2.0*uPoints[i2+1]-p1y*0.5-p3y*0.5;\n'+
        'float p2z = 2.0*uPoints[i2+2]-p1z*0.5-p3z*0.5;\n'+
        'return vec3(t2*t2*p1x+2.0*t2*t*p2x+t*t*p3x, t2*t2*p1y+2.0*t2*t*p2y+t*t*p3y, t2*t2*p1z+2.0*t2*t*p2z+t*t*p3z); }\n';

GpuShaders.planeVertexShader =
    'attribute vec3 aPosition;\n'+
    'attribute vec2 aTexCoord;\n'+
    'uniform mat4 uMV, uProj;\n'+
    'uniform vec4 uParams;\n'+    //[uGridStep1, unused, indexFactor, uGridStep2]
    'uniform vec4 uParams3;\n'+    //[px, py, sx, sy]
    'uniform float uPoints[9*3];\n'+

    '#ifndef poles\n'+
        'uniform vec3 uVector;\n'+
        'uniform float uHeights[9];\n'+
    '#endif\n'+

    'varying vec2 vTexCoord;\n'+
    'varying vec2 vTexCoord2;\n'+
    'varying float vDepth;\n'+ GpuShaders.quadPoint +

    '#ifndef poles\n'+
        'float linearHeight(float x, float y) {\n'+
            'int ix = int(x);\n'+
            'int iy = int(y);\n'+
            'int index = (2-iy)*3+ix;\n'+
            'int index2 = (2-(iy+1))*3+ix;\n'+
            'float fx = fract(x);\n'+
            'float fy = fract(y);\n'+
            'float w0 = (uHeights[index] + (uHeights[index+1] - uHeights[index])*fx);\n'+
            'float w1 = (uHeights[index2] + (uHeights[index2+1] - uHeights[index2])*fx);\n'+
            'return (w0 + (w1 - w0)*fy);\n'+
        '}\n'+
    '#endif\n'+

    'void main() {\n'+
        'vec3 indices = aPosition;\n'+
        'float t = aPosition.y * uParams[2];\n'+  //vertical index
        'float tt = t;\n'+
        'float t2 = (1.0-t);\n'+
        'vec3 p1 = quadPoint(0, 3, 6, t, t2);\n'+
        'vec3 p2 = quadPoint(9, 9+3, 9+6, t, t2);\n'+
        'vec3 p3 = quadPoint(18, 18+3, 18+6, t, t2);\n'+
        't = aPosition.x * uParams[2];\n'+  //horizontal index
        'float tt2 = t;\n'+
        't2 = (1.0-t);\n'+
        'float p2x = 2.0*p2.x-p1.x*0.5-p3.x*0.5;\n'+
        'float p2y = 2.0*p2.y-p1.y*0.5-p3.y*0.5;\n'+
        'float p2z = 2.0*p2.z-p1.z*0.5-p3.z*0.5;\n'+
        'vec4 p = vec4(t2*t2*p1.x+2.0*t2*t*p2x+t*t*p3.x, t2*t2*p1.y+2.0*t2*t*p2y+t*t*p3.y, t2*t2*p1.z+2.0*t2*t*p2z+t*t*p3.z, 1);\n'+

        '#ifndef poles\n'+
            '#ifndef flat\n'+
                'p.xyz += uVector * linearHeight(tt*2.0, tt2*2.0);\n'+
            '#endif\n'+
        '#endif\n'+

        'vec4 camSpacePos = uMV * p;\n'+
        'gl_Position = uProj * camSpacePos;\n'+
        'float camDist = length(camSpacePos.xyz);\n'+

        'vDepth = camDist;\n'+

        'vec2 uv;\n'+
        'uv.x = aTexCoord.y * uParams3[2] + uParams3[0];\n'+
        'uv.y = (1.0-aTexCoord.x) * uParams3[3] + uParams3[1];\n'+
        'vTexCoord = uv;\n'+
        'vTexCoord2 = p.xy;\n'+
    '}';

GpuShaders.planeFragmentShader = 'precision mediump float;\n'+
    'uniform sampler2D uSampler;\n'+
    'uniform vec4 uParams2;\n'+    //[uGridStep1, uGridStep2, uGridBlend, 0]

    '#ifdef poles\n'+
        'uniform vec4 uParams4;\n'+    //[pole-x, pole-y, pole-radius, 0]
        'varying vec2 vTexCoord2;\n'+
    '#endif\n'+

    'varying vec2 vTexCoord;\n'+
    'varying float vDepth;\n'+
    'void main() {\n'+
        '#ifdef poles\n'+
            'if (length(uParams4.xy - vTexCoord2.xy) > uParams4.z){ discard; }\n'+
        '#endif\n'+

        '#ifdef depth\n'+
            'gl_FragColor = fract(vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0) * vDepth) + (-0.5/255.0);\n'+
        '#else\n'+
            'vec4 c = mix(texture2D(uSampler, vTexCoord), texture2D(uSampler, vTexCoord*8.0), uParams2[2]);\n'+
            'gl_FragColor = c;\n'+
        '#endif\n'+
    '}';


//textured tile mesh
GpuShaders.tileVertexShader =
    'attribute vec3 aPosition;\n'+

    '#if defined(externalTex) || defined(shader_illumination)\n' +
        'attribute vec2 aTexCoord2;\n'+
    '#else\n'+
        'attribute vec2 aTexCoord;\n'+
    '#endif\n'+

    'varying vec2 vTexCoord;\n'+

    '#ifdef clip4\n'+
        '#if !defined(externalTex) && !defined(shader_illumination)\n'+
            'attribute vec2 aTexCoord2;\n'+
        '#endif\n'+

        'varying vec2 vClipCoord;\n'+
    '#endif\n'+

    '#ifdef clip8\n'+
        '#if !defined(externalTex) && !defined(shader_illumination)\n'+
            'attribute vec2 aTexCoord2;\n'+
        '#endif\n'+

        'varying vec3 vClipCoord;\n'+

        'uniform mat4 uParamsC8;\n'+  //c,x,y,z

        'float getLinePointParametricDist(vec3 c, vec3 v, vec3 p) {\n'+
            'vec3 w = p - c;\n'+
            'float c1 = dot(w,v);\n'+
            'if (c1 <= 0.0) return 0.0;\n'+
            'float c2 = dot(v,v);\n'+
            'if (c2 <= c1) return 1.0;\n'+
            'return c1 / c2;\n'+
        '}\n'+

    '#endif\n'+

    '#ifdef depth\n'+
        'varying float vDepth;\n'+
    '#endif\n'+

    '#ifdef flatShadeVar\n'+
        'varying vec3 vBarycentric;\n'+
    '#endif\n'+

    '#ifdef shader_illumination\n' +
        'varying vec3 fragPos;\n' +
        'varying vec2 nmTexCoord;\n' +
    "#endif\n" +
                                                //0-3                            4-7          8-11            12-15
    'uniform mat4 uMV, uProj, uParams;\n'+

    '#ifdef applySE\n'+              // 0-3                        4-7                     8-11             12-15
        'uniform mat4 uParamsSE;\n'+ // [bbox.min.xyz, bbox.side.x][bbox.side.yz, n/a, n/a][n/a, h1, f1, h2][1/(h2-h1), f2-f1, body.a, body.a / body.b]
    '#endif\n'+

    'void main() {\n'+

        '#ifdef applySE\n'+
            // scale by bbox size - this is metric, but relative to bbox pos
            'vec3 geoPos2 = aPosition*vec3(uParamsSE[0][3],uParamsSE[1][0],uParamsSE[1][1]);\n'+
            // translate to bbox pos - this is the world position, same as worldPos below
            'vec3 geoPos = geoPos2+vec3(uParamsSE[0][0],uParamsSE[0][1],uParamsSE[0][2]);\n'+
            // looks like we transform ellipsoid to a sphere here
            'geoPos.z *= uParamsSE[3][3];\n'+
            // distance from earth center, sort of
            'float ll = length(geoPos);\n'+
            // earth normal
            'vec3 v = geoPos * (1.0/(ll+0.0001));\n'+
            // ellipsoidal height, sort of
            'float h = ll - uParamsSE[3][2];\n'+
            // h_ = clamp(h, h1, h2)
            'float h2 = clamp(h, uParamsSE[2][1], uParamsSE[2][3]);\n'+
            'float h3 = h;\n'+
            // h * = (h_ - h1) /(h2 - h1) * (f2 - f1)
            'h *= (uParamsSE[2][2] + ((h2 - uParamsSE[2][1]) * uParamsSE[3][0]) * uParamsSE[3][1]);\n'+
            // move relative bbox pos along the normal by the difference obtained due to exaggeration
            'geoPos2.xyz += v * (h - h3);\n'+
            // uMV in case of SE is different then below, without the bbox scaling (we already have the metric coordinates
            // this is result of submesh.getWorldMatrixSE
            'vec4 camSpacePos = uMV * vec4(geoPos2, 1.0);\n'+
        '#else\n'+
            'vec4 camSpacePos = uMV * vec4(aPosition, 1.0);\n'+
        '#endif\n'+

        '#ifdef shader_illumination\n' +
            // wow, we use the normalized submesh coordinates instead of world coordinates. Probably wrong.
            'fragPos = aPosition;\n' +
            // for sampling normal maps (not transformed)
            'nmTexCoord = aTexCoord2;\n' +
        "#endif\n" +

        'gl_Position = uProj * camSpacePos;\n'+
        'float camDist = length(camSpacePos.xyz);\n'+

        '#ifdef depth\n'+
            'vDepth = camDist;\n'+
        '#endif\n'+

        '#ifdef flatShadeVar\n'+
            'vBarycentric = camSpacePos.xyz;\n'+
        '#endif\n'+

        '#ifdef externalTex\n'+
            // texture transformation, for textures propagated from higher lods
            'vTexCoord = vec2(uParams[2][0] * aTexCoord2[0] + uParams[2][2], uParams[2][1] * aTexCoord2[1] + uParams[2][3]);\n'+
        '#elif defined(shader_illumination)\n' +
            // not sure, perhaps no longer needed - we use nmTexCoord
            'vTexCoord = aTexCoord2;\n' +
        '#else\n'+
            // internal texture
            'vTexCoord = aTexCoord;\n'+
        '#endif\n'+

        '#ifdef clip4\n'+
            'vClipCoord.xy = aTexCoord2.xy;\n'+
        '#endif\n'+

        '#ifdef clip8\n'+
            //'vClipCoord.x = getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[1][0],uParamsC8[1][1],uParamsC8[1][2]), camSpacePos.xyz);\n'+
            //'vClipCoord.y = getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[2][0],uParamsC8[2][1],uParamsC8[2][2]), camSpacePos.xyz);\n'+
            //'vClipCoord.z = getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[3][0],uParamsC8[3][1],uParamsC8[3][2]), camSpacePos.xyz);\n'+

            'vec3 worldPos2 = vec3(aPosition.x * uParams[0][2] + uParamsC8[0][3], aPosition.y * uParams[0][3] + uParamsC8[1][3], aPosition.z * uParams[3][0] + uParamsC8[2][3]);\n'+

            'vClipCoord.x = getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[1][0],uParamsC8[1][1],uParamsC8[1][2]), worldPos2.xyz);\n'+
            'vClipCoord.y = getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[2][0],uParamsC8[2][1],uParamsC8[2][2]), worldPos2.xyz);\n'+
            'vClipCoord.z = 1.0-getLinePointParametricDist(vec3(uParamsC8[0][0],uParamsC8[0][1],uParamsC8[0][2]), vec3(uParamsC8[3][0],uParamsC8[3][1],uParamsC8[3][2]), worldPos2.xyz);\n'+
            //'vClipCoord.xyz = vec3(0.0, 0.0, 1.0);\n'+
        '#endif\n'+
    '}';

let decodeOct = `

// octahedron rg decoding of normals

vec3 decodeOct(vec2 rg, bool normalize_) {
    vec2 p = rg * 2.0 - 1.0;                          // [-1,1]^2
    vec3 n = vec3(p, 1.0 - abs(p.x) - abs(p.y));      // L1 “unproject”
    // branchless fold fixup (t = amount to slide back to the upper sheet)
    float t = clamp(-n.z, 0.0, 1.0);                  // >0 only when z<0
    n.xy += vec2(p.x >= 0.0 ? -t : t,
                 p.y >= 0.0 ? -t : t);

    if (! normalize_) return n;
    return normalize(n);
}


// manual biliniear filtering of decoded values
// (we cannot rely on gl interpolation, octahedron encoding is not continuous)

vec3 sampleOctBilinear(sampler2D tex, vec2 uv, vec2 texel) {

  vec2 pos = uv / texel - 0.5;
  vec2 f = fract(pos);
  vec2 base = (floor(pos) + 0.5) * texel;

  vec2 uv00 = base;
  vec2 uv10 = base + vec2(texel.x,0.0);
  vec2 uv01 = base + vec2(0.0,texel.y);
  vec2 uv11 = base + texel;

  vec3 n00 = decodeOct(texture2D(tex, uv00).rg, false);
  vec3 n10 = decodeOct(texture2D(tex, uv10).rg, false);
  vec3 n01 = decodeOct(texture2D(tex, uv01).rg, false);
  vec3 n11 = decodeOct(texture2D(tex, uv11).rg, false);

  vec3 n0 = mix(n00, n10, f.x), n1 = mix(n01, n11, f.x);
  return normalize(mix(n0, n1, f.y));
}



vec3 sampleNormal(sampler2D tex, vec2 uv, vec3 worldPos) {
    vec2 rg = texture2D(tex, uv).rg;

    // optionally add; manual bilinear fiterling + jitter
    //return decodeOct(rg);

    // TODO: pass texture size via unifom or textureSize once on GLSL ES 3.0
    return sampleOctBilinear(tex, uv, vec2(1./256., 1./256.));
}

`;

GpuShaders.tileFragmentShader = 'precision mediump float;\n'+

    '#ifdef clip4\n'+
        'uniform float uClip[4];\n'+
        'varying vec2 vClipCoord;\n'+
    '#endif\n'+

    '#ifdef clip8\n'+
        'uniform float uClip[8];\n'+
        'varying vec3 vClipCoord;\n'+
    '#endif\n'+


    'varying vec2 vTexCoord;\n'+
    'uniform sampler2D uSampler;\n'+

    '#ifdef mask\n'+
        'uniform sampler2D uSampler2;\n'+
    '#endif\n'+

    '#ifdef shader_illumination\n' +
        'uniform sampler2D normalMap;\n' +
        'uniform vec3 lightDir;\n' +
        'uniform vec3 viewPos;\n' +
        'uniform float ambientCoef;\n' +
        'varying vec3 fragPos;\n' +
        'varying vec2 nmTexCoord;\n' +
    '#endif\n' +

    '#ifdef whitewash\n' +
        'uniform float uWhitewash;\n' +
    '#endif\n' +

    '#ifdef depth\n'+
        'varying float vDepth;\n'+
    '#endif\n'+

    '#ifdef flatShadeVar\n'+
        'varying vec3 vBarycentric;\n'+

        '#ifdef fogAndColor\n'+
            'uniform vec4 uColor;\n'+
        '#endif\n'+

    '#endif\n'+

    'uniform vec4 uParams2;\n'+

    '#ifdef shader_illumination\n' +
    decodeOct +
    '#endif\n' +

    'void main() {\n'+

        '#ifdef clip4_nomargin\n'+
            'if (vClipCoord.y > 0.5){\n'+
                'if (vClipCoord.x > 0.5){\n'+
                    'if (uClip[3] == 0.0) discard;\n'+
                '} else {\n'+
                    'if (uClip[2] == 0.0) discard;\n'+
                '}\n'+
            '} else {\n'+
                'if (vClipCoord.x > 0.5){\n'+
                    'if (uClip[1] == 0.0) discard;\n'+
                '} else {\n'+
                    'if (uClip[0] == 0.0) discard;\n'+
                '}\n'+
            '}\n'+
        '#endif\n'+

        '#ifdef clip4\n'+
            'if (vClipCoord.y > 0.5){\n'+
                'if (vClipCoord.x > 0.5){\n'+
                    'if (uClip[3] == 0.0 && !(vClipCoord.x < TMAX && uClip[2] != 0.0) && !(vClipCoord.y < TMAX && uClip[1] != 0.0)) discard;\n'+
                '} else {\n'+
                    'if (uClip[2] == 0.0 && !(vClipCoord.x > TMIN && uClip[3] != 0.0) && !(vClipCoord.y < TMAX && uClip[0] != 0.0)) discard;\n'+
                '}\n'+
            '} else {\n'+
                'if (vClipCoord.x > 0.5){\n'+
                    'if (uClip[1] == 0.0 && !(vClipCoord.x < TMAX && uClip[0] != 0.0) && !(vClipCoord.y > TMIN && uClip[3] != 0.0)) discard;\n'+
                '} else {\n'+
                    'if (uClip[0] == 0.0 && !(vClipCoord.x > TMIN && uClip[1] != 0.0) && !(vClipCoord.y > TMIN && uClip[2] != 0.0)) discard;\n'+
                '}\n'+
            '}\n'+
        '#endif\n'+

        '#ifdef clip8\n'+
            'if (vClipCoord.z <= 0.5){\n'+
                'if (vClipCoord.y <= 0.5){\n'+
                    'if (vClipCoord.x > 0.5){\n'+
                        'if (uClip[5] == 0.0) discard;\n'+
                    '} else {\n'+
                        'if (uClip[4] == 0.0) discard;\n'+
                    '}\n'+
                '} else {\n'+
                    'if (vClipCoord.x > 0.5){\n'+
                        'if (uClip[7] == 0.0) discard;\n'+
                    '} else {\n'+
                        'if (uClip[6] == 0.0) discard;\n'+
                    '}\n'+
                '}\n'+
            '} else {\n'+
                'if (vClipCoord.y <= 0.5){\n'+
                    'if (vClipCoord.x > 0.5){\n'+
                        'if (uClip[1] == 0.0) discard;\n'+
                    '} else {\n'+
                        'if (uClip[0] == 0.0) discard;\n'+
                    '}\n'+
                '} else {\n'+
                    'if (vClipCoord.x > 0.5){\n'+
                        'if (uClip[3] == 0.0) discard;\n'+
                    '} else {\n'+
                        'if (uClip[2] == 0.0) discard;\n'+
                    '}\n'+
                '}\n'+
            '}\n'+
        '#endif\n'+

        '#ifdef shader_illumination\n' +
            //'vec3 normal_ = texture2D(normalMap, nmTexCoord).rgb * 2.0 - 1.0;\n' +
            'vec3 normal_ = sampleNormal(normalMap, nmTexCoord, fragPos);\n' +
            'float diffuseCoef = max(dot(-lightDir, normal_), 0.0);\n' +
        '#endif\n' +

        '#ifdef flatShadeVar\n'+
            '#ifdef flatShadeVarFallback\n'+
                'vec4 flatShadeData = vec4(1.0);\n'+
            '#else\n'+
                '#ifdef GL_OES_standard_derivatives\n'+
                    'vec3 nx = dFdx(vBarycentric);\n'+
                    'vec3 ny = dFdy(vBarycentric);\n'+
                    'vec3 normal=normalize(cross(nx,ny));\n'+
                    'vec4 flatShadeData = vec4(vec3(max(0.0,normal.z*(204.0/255.0))+(32.0/255.0)),1.0);\n'+
                '#else\n'+
                    'vec4 flatShadeData = vec4(1.0);\n'+
                '#endif\n'+
            '#endif\n'+
        '#endif\n'+

        '#ifdef flatShade\n'+
            '#ifdef shader_illumination\n' +
                '//flatShadeData = vec4(texture2D(normalMap, vTexCoord.xy));\n' +
                'flatShadeData = vec4((ambientCoef + diffuseCoef) * vec3(0.9, 0.9, 0.8), 1.0);\n' +
            '#endif\n' +

            '#ifdef fogAndColor\n'+
                'gl_FragColor = vec4(uColor.xyz * flatShadeData.xyz, uColor.w);\n'+
            '#else\n'+
                'gl_FragColor = vec4(flatShadeData.xyz, 1.0);\n'+
            '#endif\n'+

        '#else\n'+

            '#ifdef depth\n'+
                'gl_FragColor = fract(vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0) * vDepth) + (-0.5/255.0);\n'+
            '#else\n'+

                '#ifdef externalTex\n'+
                    'vec4 c = texture2D(uSampler, vTexCoord);'+'__FILTER__' + '\n' +
                    '#ifndef blendMultiply\n'+
                        'vec4 cc = c;\n'+
                        'cc.w = c.w * uParams2.w;\n'+
                    '#endif\n'+
                    '#ifdef blendMultiply\n'+
                        'vec4 cc = vec4(0.0);\n'+
                        'cc.w = c.w * uParams2.w * (1.0 - c.y);\n' +
                    '#endif\n'+
                    '#ifdef shader_illumination\n'+
                        'cc = vec4((ambientCoef + diffuseCoef) * vec3(c), cc.w);\n' +
                    '#endif\n'+
                    '#ifdef whitewash\n' +
                        'cc = vec4(mix(vec3(cc), vec3(1.0), uWhitewash), cc.w);\n' +
                    '#endif\n'+
                    '#ifdef mask\n'+
                        'vec4 c2 = texture2D(uSampler2, vTexCoord.xy);\n'+
                        'cc.w *= c2.x;\n'+
                    '#endif\n'+

                    'gl_FragColor = cc;\n'+
                '#else\n'+
                    'gl_FragColor = texture2D(uSampler, vTexCoord);\n'+
                '#endif\n'+

            '#endif\n'+

        '#endif\n'+

        // '#ifdef clip8\n'+
          //  'gl_FragColor = vec4(vClipCoord.x, vClipCoord.y, vClipCoord.z, 1.0);\n'+
        // '#endif\n'+
    '}';

//used for 2d images
GpuShaders.imageVertexShader = '\n'+
    'attribute vec4 aPosition;\n'+
    'uniform mat4 uProjectionMatrix;\n'+
    'uniform mat4 uData;\n'+
    'uniform vec4 uColor;\n'+
    'uniform float uDepth;\n'+
    'varying vec4 vColor;\n'+
    'varying vec2 vTexcoords;\n'+
    'void main(void){\n'+
        'int i=int(aPosition.x);\n'+
        //"gl_Position=uProjectionMatrix*vec4(floor(uData[i][0]+0.1),floor(uData[i][1]+0.1),0.0,1.0);\n"+
        //IE11 :(

        'vec4 p;\n'+

        'if(i==0) p = vec4(floor(uData[0][0]+0.1),floor(uData[0][1]+0.1),uDepth,1.0), vTexcoords=vec2(uData[0][2], uData[0][3]);\n'+
        'if(i==1) p = vec4(floor(uData[1][0]+0.1),floor(uData[1][1]+0.1),uDepth,1.0), vTexcoords=vec2(uData[1][2], uData[1][3]);\n'+
        'if(i==2) p = vec4(floor(uData[2][0]+0.1),floor(uData[2][1]+0.1),uDepth,1.0), vTexcoords=vec2(uData[2][2], uData[2][3]);\n'+
        'if(i==3) p = vec4(floor(uData[3][0]+0.1),floor(uData[3][1]+0.1),uDepth,1.0), vTexcoords=vec2(uData[3][2], uData[3][3]);\n'+

        'gl_Position=uProjectionMatrix*p;\n'+
        'vec4 c=uColor;\n'+
        'c.w*=1.0;\n'+
        'vColor=c;\n'+
    '}';


GpuShaders.imageFragmentShader = 'precision mediump float;\n'+
    'varying vec4 vColor;\n'+
    'varying vec2 vTexcoords;\n'+
    'uniform sampler2D uSampler;\n'+
    'void main(void){\n'+
        'vec4 c=texture2D(uSampler, vec2(vTexcoords.x, vTexcoords.y) );\n'+
        'c*=vColor;\n'+
        'if(c.w < 0.01){ discard; }\n'+
        'gl_FragColor = c;\n'+
    '}';


export default GpuShaders;
