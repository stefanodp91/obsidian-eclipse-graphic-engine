require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ObsidianEclipseCapacitorPlugins'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'MIT'
  s.homepage = 'https://github.com/stefanodp91/obsidian-eclipse-graphic-engine'
  s.author = 'Obsidian Eclipse'
  s.source = { :git => 'https://github.com/stefanodp91/obsidian-eclipse-graphic-engine.git', :tag => "v#{s.version}" }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
