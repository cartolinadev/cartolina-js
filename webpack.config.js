
var path = require('path');
var pkg = require('./package.json');
var fs = require("fs");
var webpack = require('webpack');

const isProd = process.env.NODE_ENV === 'production';

var VERSION = pkg.version;

var TARGET_DIR = isProd ? path.join(__dirname, 'dist', VERSION) : path.join(__dirname, 'build');


var LicenseWebpackPlugin = require('license-webpack-plugin').LicenseWebpackPlugin;
var MiniCssExtractPlugin = require('mini-css-extract-plugin');
var CopyPlugin = require('copy-webpack-plugin');

var plugins = [
    new LicenseWebpackPlugin({ outputFilename: '3rdpartylicenses.txt' }),
    new MiniCssExtractPlugin({ filename: '[name]' + (isProd ? '.min' : '') + '.css' }),
    new webpack.BannerPlugin({
        "banner": function(filename) {
          return "Copyright (c) 2020 Melown Technologies SE\n" +
                 "	    (c) 2025 Montevallo Consulting s.r.o.\n" +
                 " *  For terms of use, see accompanying [name] file.\n" +
                 " *  For 3rd party libraries licenses, see 3rdpartylicenses.txt.\n"
        }
    }),
    new CopyPlugin({
      patterns: [
        { from: './LICENSE', to: 'cartolina.js' + (isProd ? '.min' : '') + '.LICENSE' },
        { from: './LICENSE', to: 'vts-core.js' + (isProd ? '.min' : '') + '.LICENSE' }
      ],
    }),    
    new webpack.DefinePlugin({ 
      __DEV__: JSON.stringify(!isProd),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
    })
];

// Base webpack config used by both outputs (global + ESM)
const baseConfig = {
  entry: {
    'vts-core': __dirname + '/src/core/index',
    'cartolina': __dirname + '/src/browser/index'
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
            options: {
              esModule: true,
            },
          },

        'css-loader']
      },
      {
        test: /\.tsx?$/,
        use: 'ts-loader'
      },
      {
        test: /\.(glsl|vs|fs)$/,
        loader: 'ts-shader-loader'
      },
      /*,
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ["@babel/preset-env", {
                targets: {
                  chrome: "90",
                  firefox: "88",
                  safari: "13",
                  edge: "90"
                },
                useBuiltIns: false
              }]
            ]
          }
        }
      }*/
    ],
  },

  output: {
    path: TARGET_DIR,
    filename: '[name]' + (isProd ? '.min' : '') + '.js',
    libraryTarget: "var",
    library: "cartolina",
    publicPath: '',
    workerPublicPath: process.env.WORKER_PATH || 
      (isProd ? '/libs/vtsjs/browser/' : '/build/')
  },

  devtool: 'source-map',

  devServer: {
    hot: false,
    liveReload: true,
    devMiddleware: {
        writeToDisk: (filePath) => {
            console.log('Writing file: ', filePath);
            return true;
        }
    },
    static: [{
        directory: path.join(__dirname, 'build'),
        publicPath: '/build',
        watch: false
    },    
    {
        directory: path.join(__dirname, 'demos'),
        publicPath: '/demos',
        watch: true
    },
    {
        directory: path.join(__dirname, 'test'),
        publicPath: '/test',
        watch: true
    }],
    open: false,
    client: {
        overlay: false
    }    
  },

  mode: (isProd) ? 'production' : 'development',

  plugins: plugins  
};

// 1) Global build: window.cartolina.browser
var globalConfig = Object.assign({}, baseConfig);
globalConfig.name = 'global';


// 2) ESM build: `import { browser } from 'cartolina.esm.js'`
var esmConfig = Object.assign({}, baseConfig);
esmConfig.name = 'esm';
esmConfig.output = Object.assign({}, baseConfig.output, {
  // put the ESM files alongside the global ones (build/ in dev, dist/<version>/ in prod)
  path: TARGET_DIR,
  filename: '[name]' + (isProd ? '.min' : '') + '.esm.js',
  libraryTarget: 'module'
});
// ESM library targets require this flag; also remove the global name
delete esmConfig.output.library;
esmConfig.experiments = Object.assign({}, baseConfig.experiments || {}, { outputModule: true });
// CRUCIAL: do NOT define devServer here. One server watches BOTH compilations.
delete esmConfig.devServer;
 
module.exports = [ globalConfig, esmConfig ];
