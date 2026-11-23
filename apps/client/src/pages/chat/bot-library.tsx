import { signal, View } from "nsh";
import { Input } from "nsh/base";
import { Button, Label, Modal, SmoothScroll } from "../../components";
import { localizedText as t } from "../../i18n";
import { botTemplates } from "./bot-templates";

export function BotLibrary(props: {
  phone: boolean;
  onClose: () => void;
  onChoose: (template: ReturnType<typeof botTemplates>[number]) => void;
}) {
  const query = signal("");
  const selected = signal("");
  const listed = () =>
    botTemplates().filter((bot) =>
      `${bot.name} ${bot.purpose}`
        .toLowerCase()
        .includes(query().trim().toLowerCase()),
    );
  const preview = () => listed().find((item) => item.name === selected());
  return (
    <Modal
      title={t("Bot templates", "Bot 模板")}
      width={385}
      phone={props.phone}
      onClose={props.onClose}
    >
      <SmoothScroll style={{ maxHeight: 440 }}>
        <View style={{ padding: 14, gap: 10 }}>
          <Input
            accessibilityLabel={t("Search templates", "搜索模板")}
            placeholder={t("Search by purpose", "按用途搜索")}
            value={query()}
            onChange={({ value }) => query.set(value)}
          />
          <Each of={listed()} key={(bot) => bot.name}>
            {(bot) => (
              <Button
                label={bot().name}
                onPress={() => selected.set(bot().name)}
              />
            )}
          </Each>
          <If when={!listed().length}>
            <Label>{t("No matching templates", "没有匹配的模板")}</Label>
          </If>
          <If when={preview()}>
            {(bot) => (
              <View style={{ gap: 8 }}>
                <Label>{bot().purpose}</Label>
                <Label tone="muted">{t("Example message", "示例消息")}</Label>
                <Label>{bot().example}</Label>
                <Label tone="muted">
                  {t(
                    "Requires a configured model. No extra tools.",
                    "需要已配置的模型，无需额外工具。",
                  )}
                </Label>
                <Button
                  tone="primary"
                  label={t("Configure and add", "配置并添加")}
                  onPress={() => props.onChoose(bot())}
                />
              </View>
            )}
          </If>
        </View>
      </SmoothScroll>
    </Modal>
  );
}
