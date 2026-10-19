# Add project specific ProGuard rules here.
# React Native keeps its own rules in the react-android artifact, so nothing
# is needed for a plain build. A release build that shrinks the code needs
# the keep rules below for the native modules.
-keep class com.facebook.react.** { *; }
-keep class dev.trycord.app.** { *; }
