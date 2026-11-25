include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Xiaomi AX9000 controls (fan, LED)
LUCI_DEPENDS:=+ax9000-controls
LUCI_PKGARCH:=all

PKG_LICENSE:=GPL-2.0-only

# luci.mk copies htdocs/ and root/ with cp -pR, keeping the source modes; on an
# NTFS bind mount those are all 0777. Normalise them in the build dir (hook
# called at the end of luci.mk's Build/Prepare) so the package gets 0755/0644.
define Build/Prepare/luci-app-ax9000-controls
	find $(PKG_BUILD_DIR) -type d -exec chmod 0755 {} +
	find $(PKG_BUILD_DIR) -type f -exec chmod 0644 {} +
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
